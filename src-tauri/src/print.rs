//! Print spooler for The Small POS.
//!
//! Provides an offline-safe print job queue backed by the `print_jobs` SQLite
//! table.  UI "Print" actions enqueue a job; a background worker generates
//! receipt output files and dispatches them to the configured Windows printer
//! via the `printers` module. Missing/unavailable hardware profile resolution
//! is treated as a non-retryable failure.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use chrono::Utc;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::db::{self, DbState};
use crate::drawer;
use crate::printers;
use crate::receipt_renderer::{
    self, AdjustmentLine, ClassicCustomerRenderMode, CommandProfile, DeliverySlipMode, FontType,
    HeaderEmphasis, KitchenTicketDoc, LayoutConfig, LayoutDensity, OrderReceiptDoc, PaymentLine,
    ReceiptCustomizationLine, ReceiptDocument, ReceiptEmulationMode, ReceiptItem, ReceiptTemplate,
    ShiftCheckoutDoc, TotalsLine, ZReportDoc, PAYMENT_DETAIL_AMOUNT_UNKNOWN,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Directory name under the app data dir where receipt files are written.
const RECEIPTS_DIR: &str = "receipts";
const AUTO_PRINT_RECEIPT_ONLY: &[&str] = &["order_receipt"];
const AUTO_PRINT_DELIVERY_ONLY: &[&str] = &["delivery_slip"];
const PRINT_QUEUE_SETTINGS_CATEGORY: &str = "printing";
const PRINT_QUEUE_PAUSED_GLOBAL_KEY: &str = "queue_paused";
const PRINT_QUEUE_PAUSED_PROFILE_PREFIX: &str = "queue_paused_profile::";
const PRINT_QUEUE_CHANGED_EVENT: &str = "print_queue_changed";
static ACTIVE_PRINT_JOBS: OnceLock<Mutex<HashMap<(String, String), ActivePrintEntry>>> =
    OnceLock::new();
static PROFILE_ASSOCIATION_COORDINATION: OnceLock<Mutex<()>> = OnceLock::new();
type NativeReconciliationRegistry = (Mutex<HashSet<(String, String)>>, std::sync::Condvar);
static NATIVE_RECONCILIATION_IN_FLIGHT: OnceLock<NativeReconciliationRegistry> = OnceLock::new();
const STALE_PRINTING_JOB_ERROR: &str = "Print attempt did not finish; it may already have reached the printer. Automatic retry stopped to prevent duplicate or gibberish output. Check the printer, then retry manually if needed.";

/// Hard wall-clock cap on a single hardware dispatch. Kept below the 30s stale
/// threshold (see `recover_stale_printing_jobs`) so a timed-out job is failed
/// closed here with a clear message rather than later re-surfacing as a stale
/// `printing` row. The unbounded Windows spooler transport is the reason this
/// exists — see `run_dispatch_with_timeout`.
const DISPATCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const NATIVE_QUEUE_CONTROL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const PRINT_HISTORY_PURGE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Error recorded when a hardware dispatch exceeds `DISPATCH_TIMEOUT`.
///
/// Failing closed no longer depends on this wording: the dispatch path decides
/// structurally, routing a timeout to `ParentTransition::ManualFailure` because the write
/// may already have reached the printer. The text is operator-facing only.
const DISPATCH_TIMEOUT_ERROR: &str = "Printer did not respond within the dispatch timeout; the receipt may or may not have printed. Automatic retry stopped to prevent duplicate output. Check the printer, then retry manually if needed.";

pub trait PrintQueueInvalidator: Send + Sync {
    fn invalidate_print_queue(&self);
}

impl PrintQueueInvalidator for tauri::AppHandle {
    fn invalidate_print_queue(&self) {
        use tauri::Emitter;
        if let Err(error) = self.emit(PRINT_QUEUE_CHANGED_EVENT, ()) {
            warn!(error = %error, "Failed to emit print queue invalidation");
        }
    }
}

pub(crate) fn notify_print_queue_changed(invalidator: &dyn PrintQueueInvalidator) {
    invalidator.invalidate_print_queue();
}

#[cfg(test)]
pub(crate) struct NoopPrintQueueInvalidator;

#[cfg(test)]
impl PrintQueueInvalidator for NoopPrintQueueInvalidator {
    fn invalidate_print_queue(&self) {}
}

#[derive(Clone)]
struct ActivePrintEntry {
    owner_id: String,
    printer_profile_registrations: HashMap<String, usize>,
    cancel: Arc<AtomicBool>,
    registrations: usize,
}

struct ActivePrintGuard {
    owner_id: String,
    job_id: String,
    printer_profile_id: Option<String>,
    cancel: Arc<AtomicBool>,
    primary: bool,
}

impl ActivePrintGuard {
    fn register(
        db: &DbState,
        job_id: &str,
        printer_profile_id: Option<String>,
    ) -> Result<Self, String> {
        let owner_id = active_print_owner_id(db)?;
        let job_id = job_id.to_string();
        let key = (owner_id.clone(), job_id.clone());
        let guard_profile_id = printer_profile_id.clone();
        let mut active = active_print_jobs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (cancel, primary) = match active.entry(key) {
            std::collections::hash_map::Entry::Occupied(mut occupied) => {
                let entry = occupied.get_mut();
                if let Some(printer_profile_id) = printer_profile_id {
                    *entry
                        .printer_profile_registrations
                        .entry(printer_profile_id)
                        .or_insert(0) += 1;
                }
                entry.registrations = entry.registrations.saturating_add(1);
                (Arc::clone(&entry.cancel), false)
            }
            std::collections::hash_map::Entry::Vacant(vacant) => {
                let cancel = Arc::new(AtomicBool::new(false));
                let printer_profile_registrations = printer_profile_id
                    .into_iter()
                    .map(|profile_id| (profile_id, 1))
                    .collect();
                vacant.insert(ActivePrintEntry {
                    owner_id: owner_id.clone(),
                    printer_profile_registrations,
                    cancel: Arc::clone(&cancel),
                    registrations: 1,
                });
                (cancel, true)
            }
        };
        Ok(Self {
            owner_id,
            job_id,
            printer_profile_id: guard_profile_id,
            cancel,
            primary,
        })
    }

    fn cancel_token(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    fn cancel_requested(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    fn is_primary(&self) -> bool {
        self.primary
    }
}

impl Drop for ActivePrintGuard {
    fn drop(&mut self) {
        let mut active = active_print_jobs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = (self.owner_id.clone(), self.job_id.clone());
        let should_remove = match active.get_mut(&key) {
            Some(entry) if Arc::ptr_eq(&entry.cancel, &self.cancel) => {
                if let Some(profile_id) = self.printer_profile_id.as_deref() {
                    let remove_profile =
                        match entry.printer_profile_registrations.get_mut(profile_id) {
                            Some(registrations) if *registrations > 1 => {
                                *registrations -= 1;
                                false
                            }
                            Some(_) => true,
                            None => false,
                        };
                    if remove_profile {
                        entry.printer_profile_registrations.remove(profile_id);
                    }
                }
                if entry.registrations > 1 {
                    entry.registrations -= 1;
                    false
                } else {
                    true
                }
            }
            _ => false,
        };
        if should_remove {
            active.remove(&key);
        }
    }
}

fn active_print_jobs() -> &'static Mutex<HashMap<(String, String), ActivePrintEntry>> {
    ACTIVE_PRINT_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn profile_association_coordination() -> &'static Mutex<()> {
    PROFILE_ASSOCIATION_COORDINATION.get_or_init(|| Mutex::new(()))
}

struct NativeReconciliationLease {
    key: (String, String),
}

fn native_reconciliation_registry() -> &'static NativeReconciliationRegistry {
    NATIVE_RECONCILIATION_IN_FLIGHT
        .get_or_init(|| (Mutex::new(HashSet::new()), std::sync::Condvar::new()))
}

impl NativeReconciliationLease {
    fn try_acquire(owner_id: &str, resolved_target: &str) -> Option<Self> {
        let key = (owner_id.to_owned(), resolved_target.trim().to_lowercase());
        let mut in_flight = native_reconciliation_registry()
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if in_flight.insert(key.clone()) {
            Some(Self { key })
        } else {
            None
        }
    }
}

impl Drop for NativeReconciliationLease {
    fn drop(&mut self) {
        let registry = native_reconciliation_registry();
        let mut in_flight = registry
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        in_flight.remove(&self.key);
        registry.1.notify_all();
    }
}

fn active_print_owner_id_with_conn(conn: &rusqlite::Connection) -> Result<String, String> {
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS active_print_registry_owner (
             singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
             owner_id TEXT NOT NULL
         );",
    )
    .map_err(|error| format!("Initialize active print registry owner: {error}"))?;
    conn.execute(
        "INSERT OR IGNORE INTO active_print_registry_owner (singleton, owner_id)
         VALUES (1, ?1)",
        [Uuid::new_v4().to_string()],
    )
    .map_err(|error| format!("Create active print registry owner: {error}"))?;
    conn.query_row(
        "SELECT owner_id FROM active_print_registry_owner WHERE singleton = 1",
        [],
        |row| row.get(0),
    )
    .map_err(|error| format!("Read active print registry owner: {error}"))
}

fn file_database_identity(path: &Path) -> String {
    #[cfg(windows)]
    let canonical = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(not(windows))]
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(windows)]
    let normalized = canonical.to_string_lossy().to_lowercase();
    #[cfg(not(windows))]
    let normalized = canonical.to_string_lossy().into_owned();
    format!("file:{normalized}")
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsByHandleFileInformation {
    file_attributes: u32,
    creation_time: WindowsFileTime,
    last_access_time: WindowsFileTime,
    last_write_time: WindowsFileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "Kernel32")]
extern "system" {
    fn GetFileInformationByHandle(
        file: std::os::windows::io::RawHandle,
        information: *mut WindowsByHandleFileInformation,
    ) -> i32;
}

#[cfg(windows)]
fn physical_file_generation(path: &Path) -> Option<String> {
    use std::os::windows::io::AsRawHandle;

    let file = std::fs::File::open(path).ok()?;
    let mut information = std::mem::MaybeUninit::<WindowsByHandleFileInformation>::uninit();
    // SAFETY: `file` remains alive for the call, its raw handle is valid, and the
    // output pointer targets correctly sized, aligned, writable storage.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return None;
    }
    // SAFETY: a nonzero API result guarantees the complete output structure was written.
    let information = unsafe { information.assume_init() };
    let file_index =
        (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low);
    Some(format!(
        "volume:{}:index:{file_index}",
        information.volume_serial_number
    ))
}

#[cfg(unix)]
fn physical_file_generation(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::metadata(path).ok()?;
    Some(format!(
        "device:{}:inode:{}",
        metadata.dev(),
        metadata.ino()
    ))
}

#[cfg(not(any(windows, unix)))]
fn physical_file_generation(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    let created = metadata
        .created()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(format!("created:{created:?}"))
}

fn print_history_validation_scope(db: &DbState) -> Result<String, String> {
    if db.db_path == Path::new(":memory:") {
        return active_print_owner_id(db);
    }

    let file_identity = file_database_identity(&db.db_path);
    let generation = physical_file_generation(&db.db_path)
        .ok_or_else(|| "Read print history database physical identity".to_string())?;

    // Physical file identity stays stable across ordinary SQLite writes and changes
    // if a new database is installed at the same path. The text is digested in the key.
    Ok(format!("{file_identity}:{generation}"))
}

fn active_print_owner_id(db: &DbState) -> Result<String, String> {
    if db.db_path != Path::new(":memory:") {
        return Ok(file_database_identity(&db.db_path));
    }

    let conn = lock_conn_recovering(db);
    active_print_owner_id_with_conn(&conn)
}

fn request_active_print_stops_for_owner(
    owner_id: &str,
    job_id: Option<&str>,
    printer_profile_id: Option<&str>,
) -> HashSet<String> {
    let active = active_print_jobs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut requested = HashSet::new();
    for ((_, active_job_id), entry) in active.iter() {
        if entry.owner_id != owner_id {
            continue;
        }
        let entry_matches = match job_id {
            Some(job_id) => active_job_id == job_id,
            None => match printer_profile_id {
                Some(profile_id) => entry.printer_profile_registrations.contains_key(profile_id),
                None => true,
            },
        };
        if entry_matches && !entry.cancel.swap(true, Ordering::AcqRel) {
            requested.insert(active_job_id.clone());
        }
    }
    requested
}

#[cfg(test)]
fn request_active_print_stops(
    db: &DbState,
    job_id: Option<&str>,
    printer_profile_id: Option<&str>,
) -> Result<usize, String> {
    let owner_id = active_print_owner_id(db)?;
    Ok(request_active_print_stops_for_owner(&owner_id, job_id, printer_profile_id).len())
}

fn matching_active_print_job_ids_for_owner(
    owner_id: &str,
    printer_profile_id: Option<&str>,
) -> HashSet<String> {
    let active = active_print_jobs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    active
        .iter()
        .filter(|((_, _), entry)| entry.owner_id == owner_id)
        .filter(|(_, entry)| match printer_profile_id {
            Some(profile_id) => entry.printer_profile_registrations.contains_key(profile_id),
            None => true,
        })
        .map(|((_, job_id), _)| job_id.clone())
        .collect()
}

fn active_print_job_is_registered_for_owner(owner_id: &str, job_id: &str) -> bool {
    let active = active_print_jobs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    active
        .get(&(owner_id.to_owned(), job_id.to_owned()))
        .is_some_and(|entry| entry.owner_id == owner_id)
}

fn request_active_print_stops_for_job_ids_and_owner(
    owner_id: &str,
    job_ids: &HashSet<String>,
) -> HashSet<String> {
    if job_ids.is_empty() {
        return HashSet::new();
    }
    let active = active_print_jobs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut requested = HashSet::new();
    for ((_, active_job_id), entry) in active.iter() {
        if entry.owner_id == owner_id
            && job_ids.contains(active_job_id)
            && !entry.cancel.swap(true, Ordering::AcqRel)
        {
            requested.insert(active_job_id.clone());
        }
    }
    requested
}

fn is_receipt_like_entity_type(entity_type: &str) -> bool {
    matches!(
        entity_type,
        "order_receipt"
            | "delivery_slip"
            | "kitchen_ticket"
            | "shift_checkout"
            | "z_report"
            | "order_completed_receipt"
            | "order_canceled_receipt"
    )
}

fn non_empty_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn looks_like_raw_terminal_id(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }

    lower.starts_with("terminal-")
        || lower.starts_with("terminal_")
        || lower.starts_with("pos-terminal-")
        || lower.starts_with("pos_terminal_")
        || lower.starts_with("term-")
}

fn sanitize_terminal_display_name(value: &str) -> Option<String> {
    let trimmed = non_empty_text(value)?;
    if looks_like_raw_terminal_id(&trimmed) {
        None
    } else {
        Some(trimmed)
    }
}

fn resolve_terminal_display_name_from_settings(conn: &rusqlite::Connection) -> Option<String> {
    ["name", "display_name", "displayName"]
        .iter()
        .find_map(|key| db::get_setting(conn, "terminal", key))
        .and_then(|value| sanitize_terminal_display_name(&value))
}

fn resolve_printed_terminal_name_with_conn(
    conn: &rusqlite::Connection,
    explicit: Option<&str>,
) -> Option<String> {
    explicit
        .and_then(sanitize_terminal_display_name)
        .or_else(|| resolve_terminal_display_name_from_settings(conn))
}

pub fn auto_print_entity_types_for_order_type(order_type: &str) -> &'static [&'static str] {
    if order_type.eq_ignore_ascii_case("delivery") {
        AUTO_PRINT_DELIVERY_ONLY
    } else {
        AUTO_PRINT_RECEIPT_ONLY
    }
}

/// Returns whether the given receipt action is enabled.
/// Reads from local_settings("receipt_actions", key).
/// Acquires and releases the DB lock internally — safe to call without holding the lock.
/// Existing triggers default to true when absent; new triggers default to false.
/// `after_edit` is a deliberate exception: an edited order must reprint its
/// updated receipt unless the operator explicitly disables it.
/// Whether the operator explicitly allowed sandbox/test orders to print
/// (receipt_actions/print_sandbox_orders). Default OFF: test orders must never
/// produce paper during a live business day unless someone is actively running
/// an integration test at this till.
pub(crate) fn sandbox_prints_allowed(conn: &rusqlite::Connection) -> bool {
    matches!(
        crate::db::get_setting(conn, "receipt_actions", "print_sandbox_orders")
            .as_deref()
            .map(str::trim),
        Some("true" | "1" | "yes" | "on")
    )
}

pub fn is_print_action_enabled(db: &DbState, key: &str) -> bool {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(_) => return true, // fail open — don't suppress print if lock poisoned
    };
    let raw = crate::db::get_setting(&conn, "receipt_actions", key);
    drop(conn);
    match raw.as_deref() {
        None => matches!(
            key,
            "after_order"
                | "after_edit"
                | "payment_receipt"
                | "split_receipt"
                | "shift_close"
                | "driver_assigned"
                | "z_report"
                | "kitchen_ticket"
                // Deliberate default-on exception like after_edit: approving a
                // platform order must hand the rider a slip without an extra
                // operator step (THE-434, founder decision 2026-08-25).
                | "after_approve"
        ),
        Some(v) => matches!(v.trim(), "true" | "1" | "yes" | "on"),
    }
}

/// Enqueue the automatic reprint for an edited order.
///
/// Mirrors the order-create auto-print: same entity types per order type,
/// gated on the `after_edit` receipt action (default on); ghost orders never
/// print. Receipt content renders at DISPATCH time from the DB, so the job
/// enqueued here — or an already-pending job for the same order that the
/// duplicate guard keeps — always prints the edited items and the full
/// payment breakdown (e.g. the original cash payment plus a card-settled
/// edit delta as separate lines, refunds as adjustment lines).
pub fn enqueue_after_edit_auto_print(
    db: &DbState,
    order_id: &str,
    order_type: &str,
    is_ghost: bool,
    invalidator: &dyn PrintQueueInvalidator,
) {
    if is_ghost {
        return;
    }
    if !is_print_action_enabled(db, "after_edit") {
        return;
    }
    for entity_type in auto_print_entity_types_for_order_type(order_type) {
        if let Err(error) = enqueue_print_job(db, entity_type, order_id, None, invalidator) {
            tracing::warn!(
                order_id = %order_id,
                entity_type = %entity_type,
                error = %error,
                "Failed to enqueue after-edit reprint job"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/// Create a new print job for the given entity.
///
/// Returns `{ success, jobId }` or an error.  Rejects duplicates for the same
/// `(entity_type, entity_id)` that are still pending or printing.
pub fn enqueue_print_job(
    db: &DbState,
    entity_type: &str,
    entity_id: &str,
    printer_profile_id: Option<&str>,
    invalidator: &dyn PrintQueueInvalidator,
) -> Result<Value, String> {
    enqueue_print_job_with_payload(
        db,
        entity_type,
        entity_id,
        printer_profile_id,
        None,
        invalidator,
    )
}

/// Create a new print job and optionally persist payload snapshot JSON.
pub fn enqueue_print_job_with_payload(
    db: &DbState,
    entity_type: &str,
    entity_id: &str,
    printer_profile_id: Option<&str>,
    entity_payload_json: Option<&Value>,
    invalidator: &dyn PrintQueueInvalidator,
) -> Result<Value, String> {
    if entity_type != "order_receipt"
        && entity_type != "kitchen_ticket"
        && entity_type != "z_report"
        && entity_type != "shift_checkout"
        && entity_type != "delivery_slip"
        && entity_type != "test_print"
        && entity_type != "split_receipt"
        && entity_type != "order_completed_receipt"
        && entity_type != "order_canceled_receipt"
    {
        return Err(format!(
            "Invalid entity_type: {entity_type}. Must be order_receipt, kitchen_ticket, shift_checkout, z_report, delivery_slip, test_print, split_receipt, order_completed_receipt, or order_canceled_receipt"
        ));
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let is_order_document = matches!(
        entity_type,
        "order_receipt"
            | "kitchen_ticket"
            | "delivery_slip"
            | "order_completed_receipt"
            | "order_canceled_receipt"
    );
    let is_sandbox_order = if is_order_document {
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM orders
                WHERE id = ?1
                  AND (
                    integration_environment = 'sandbox'
                    OR COALESCE(is_test, 0) = 1
                  )
             )",
            params![entity_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        // Older test fixtures without the environment columns fail closed to
        // their legacy behavior; all migrated application databases have v71.
        .unwrap_or(false)
    } else if entity_type == "split_receipt" {
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM payments p
                JOIN orders o ON o.id = p.order_id
                WHERE p.id = ?1
                  AND (
                    o.integration_environment = 'sandbox'
                    OR COALESCE(o.is_test, 0) = 1
                  )
             )",
            params![entity_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .unwrap_or(false)
    } else {
        false
    };

    // THE-437 follow-up: the sandbox guard stays the default, but during
    // integration testing the operator can flip receipt_actions/
    // print_sandbox_orders to see real paper — every such slip prints with a
    // «ΔΟΚΙΜΗ TEST» banner so it can never pass for a customer receipt.
    if is_sandbox_order && !sandbox_prints_allowed(&conn) {
        return Ok(serde_json::json!({
            "success": true,
            "skipped": true,
            "reason": "sandbox_order",
            "jobId": null,
        }));
    }

    // Idempotency: reject if a pending/printing job already exists for this entity
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM print_jobs
             WHERE entity_type = ?1 AND entity_id = ?2
               AND status IN ('pending', 'printing')",
            params![entity_type, entity_id],
            |row| row.get(0),
        )
        .ok();

    if let Some(existing_id) = existing {
        return Ok(serde_json::json!({
            "success": true,
            "jobId": existing_id,
            "message": "Print job already queued",
            "duplicate": true,
        }));
    }

    let job_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let payload_string =
        entity_payload_json.and_then(|payload| serde_json::to_string(payload).ok());

    conn.execute(
        "INSERT INTO print_jobs (id, entity_type, entity_id, entity_payload_json, printer_profile_id,
                                 status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)",
        params![
            job_id,
            entity_type,
            entity_id,
            payload_string,
            printer_profile_id,
            now
        ],
    )
    .map_err(|e| format!("enqueue print job: {e}"))?;
    drop(conn);

    notify_print_queue_changed(invalidator);

    info!(job_id = %job_id, entity_type = %entity_type, entity_id = %entity_id, "Print job enqueued");

    Ok(serde_json::json!({
        "success": true,
        "jobId": job_id,
        "message": "Print job enqueued",
    }))
}

/// Fully rendered printer-wizard sample ready to enter the managed print
/// lifecycle. The caller resolves the exact candidate and renders the bytes
/// once; the worker subsequently consumes only the immutable snapshot.
#[derive(Clone, Debug)]
pub(crate) struct PreRenderedTestPrint {
    pub wizard_session_id: String,
    pub sample_kind: String,
    pub effective_profile_id: String,
    pub effective_profile_name: String,
    pub saved_profile_id: Option<String>,
    pub target: printers::ResolvedPrinterTarget,
    pub bytes: Vec<u8>,
    pub layout: LayoutConfig,
    pub candidate_connection_details: Value,
    pub candidate_capabilities: Value,
    pub driver_type: String,
    pub cut_paper: bool,
    pub logo_configured: bool,
    pub logo_included: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct PreRenderedTestPrintOutcome {
    pub job_id: String,
    pub duplicate: bool,
    pub queue_state: String,
    pub sample_kind: String,
    pub candidate_connection_details: Value,
    pub candidate_capabilities: Value,
    pub logo_configured: bool,
    pub logo_included: bool,
}

fn wizard_target_component(value: &str) -> String {
    value.trim().to_lowercase()
}

fn wizard_length_prefixed_target(transport: &str, component: &str, suffix: Option<u64>) -> String {
    match suffix {
        Some(suffix) => format!("{transport}:{}:{component}:{suffix}", component.len()),
        None => format!("{transport}:{}:{component}", component.len()),
    }
}

pub(crate) fn wizard_physical_target_key(target: &printers::ResolvedPrinterTarget) -> String {
    match target {
        printers::ResolvedPrinterTarget::WindowsQueue { printer_name } => {
            let queue = wizard_target_component(printer_name);
            wizard_length_prefixed_target("windows", &queue, None)
        }
        printers::ResolvedPrinterTarget::RawTcp { host, port } => {
            let host = wizard_target_component(host);
            wizard_length_prefixed_target("raw_tcp", &host, Some(u64::from(*port)))
        }
        printers::ResolvedPrinterTarget::SerialPort { port_name, .. } => {
            let port = wizard_target_component(port_name);
            wizard_length_prefixed_target("serial", &port, None)
        }
    }
}

fn wizard_evidence_contains_secret(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let normalized = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            matches!(
                normalized.as_str(),
                "password"
                    | "passphrase"
                    | "secret"
                    | "token"
                    | "apikey"
                    | "authorization"
                    | "credential"
                    | "credentials"
            ) || wizard_evidence_contains_secret(value)
        }),
        Value::Array(values) => values.iter().any(wizard_evidence_contains_secret),
        _ => false,
    }
}

fn validate_pre_rendered_test_print(request: &PreRenderedTestPrint) -> Result<(), String> {
    let session = request.wizard_session_id.trim();
    if session.is_empty() || session.len() > 128 {
        return Err("wizard_session_id must contain 1 to 128 bytes".into());
    }
    if !matches!(
        request.sample_kind.as_str(),
        "transport_text" | "encoding" | "branding"
    ) {
        return Err("Unsupported printer wizard sample kind".into());
    }
    if request.effective_profile_id.trim().is_empty()
        || request.effective_profile_id.len() > 256
        || request.effective_profile_name.trim().is_empty()
        || request.effective_profile_name.len() > 512
    {
        return Err("Printer wizard sample has invalid profile identity".into());
    }
    if request.bytes.is_empty() {
        return Err("Printer wizard sample produced no transport bytes".into());
    }
    if request.logo_included && !request.logo_configured {
        return Err("Printer wizard sample claims an unconfigured logo".into());
    }
    if !request.candidate_connection_details.is_object()
        || !request.candidate_capabilities.is_object()
    {
        return Err("Printer wizard candidate evidence must be JSON objects".into());
    }
    if wizard_evidence_contains_secret(&request.candidate_connection_details)
        || wizard_evidence_contains_secret(&request.candidate_capabilities)
    {
        return Err("Printer wizard candidate evidence contains secret fields".into());
    }
    let evidence_size = serde_json::to_vec(&serde_json::json!({
        "connection": request.candidate_connection_details,
        "capabilities": request.candidate_capabilities,
    }))
    .map_err(|error| format!("Serialize printer wizard evidence: {error}"))?
    .len();
    if evidence_size > 16 * 1024 {
        return Err("Printer wizard candidate evidence exceeds 16 KiB".into());
    }
    Ok(())
}

fn frozen_envelope_for_pre_rendered_test(request: &PreRenderedTestPrint) -> FrozenRenderEnvelope {
    FrozenRenderEnvelope {
        version: MANAGED_ENVELOPE_VERSION,
        renderer_layout_revision: receipt_renderer::layout_revision().to_owned(),
        effective_profile_id: request.effective_profile_id.clone(),
        effective_profile_name: request.effective_profile_name.clone(),
        driver_type: request.driver_type.clone(),
        document_kind: "test_print".to_owned(),
        transport: FrozenTargetEnvelope::from_resolved(&request.target),
        paper_width_mm: frozen_paper_width_mm(request.layout.paper_width),
        printable_width_dots: request.layout.printable_width_dots,
        left_margin_dots: request.layout.left_margin_dots,
        encoding: request.layout.character_set.clone(),
        code_page: request.layout.escpos_code_page,
        greek_render_mode: request.layout.greek_render_mode.clone(),
        command_profile: frozen_enum_name(request.layout.command_profile),
        emulation: frozen_enum_name(request.layout.emulation_mode),
        template: frozen_enum_name(request.layout.template),
        font_type: frozen_enum_name(request.layout.font_type),
        layout_density: frozen_enum_name(request.layout.layout_density),
        header_emphasis: frozen_enum_name(request.layout.header_emphasis),
        layout_density_scale: request.layout.layout_density_scale,
        text_scale: request.layout.text_scale,
        classic_customer_render_mode: frozen_enum_name(request.layout.classic_customer_render_mode),
        raster_threshold: request.layout.raster_threshold,
        body_font_weight: request.layout.body_font_weight,
        decimal_comma: request.layout.decimal_comma,
        detected_brand: request.layout.detected_brand.label().to_ascii_lowercase(),
        language: request.layout.language.clone(),
        organization_name: request.layout.organization_name.clone(),
        store_subtitle: request.layout.store_subtitle.clone(),
        store_address: request.layout.store_address.clone(),
        store_phone: request.layout.store_phone.clone(),
        vat_number: request.layout.vat_number.clone(),
        tax_office: request.layout.tax_office.clone(),
        footer_text: request.layout.footer_text.clone(),
        show_qr_code: request.layout.show_qr_code,
        qr_configured: request
            .layout
            .qr_data
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty()),
        copy_label: request.layout.copy_label.clone(),
        currency_symbol: request.layout.currency_symbol.clone(),
        cut_paper: request.cut_paper,
        logo_enabled: request.logo_configured,
        logo_configured: request.logo_configured,
        logo_included: request.logo_included,
        logo_scale: request.layout.logo_scale,
        drawer: FrozenDrawerConfig {
            profile_id: request.effective_profile_id.clone(),
            enabled: false,
            mode: "none".to_owned(),
            host: None,
            port: 9100,
        },
        warning_codes: Vec::new(),
    }
}

fn outcome_from_existing_wizard_job(
    job_id: String,
    queue_state: String,
    payload_json: String,
) -> Result<PreRenderedTestPrintOutcome, String> {
    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|error| format!("Read existing printer wizard evidence: {error}"))?;
    Ok(PreRenderedTestPrintOutcome {
        job_id,
        duplicate: true,
        queue_state,
        sample_kind: payload
            .get("sampleKind")
            .and_then(Value::as_str)
            .unwrap_or("transport_text")
            .to_owned(),
        candidate_connection_details: payload
            .get("candidateConnectionDetails")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        candidate_capabilities: payload
            .get("candidateCapabilities")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        logo_configured: payload
            .get("logoConfigured")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        logo_included: payload
            .get("logoIncluded")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn enqueue_pre_rendered_test_print_with_transaction_hook(
    db: &DbState,
    request: PreRenderedTestPrint,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<PreRenderedTestPrintOutcome, String> {
    validate_pre_rendered_test_print(&request)?;
    let target_identity = wizard_physical_target_key(&request.target);
    if target_identity.len() > 1024 {
        return Err("Printer wizard target identity is too long".into());
    }
    let encoded = crate::print_snapshot::encode_print_payload(&request.bytes)?;
    let envelope = frozen_envelope_for_pre_rendered_test(&request);
    envelope.validate("test_print")?;
    let envelope_json = serde_json::to_string(&envelope)
        .map_err(|error| format!("Serialize printer wizard envelope: {error}"))?;
    let evidence = serde_json::json!({
        "source": "printer_setup_sample",
        "wizardSessionId": request.wizard_session_id,
        "sampleKind": request.sample_kind,
        "targetKey": target_identity,
        "candidateConnectionDetails": request.candidate_connection_details,
        "candidateCapabilities": request.candidate_capabilities,
        "logoConfigured": request.logo_configured,
        "logoIncluded": request.logo_included,
    });
    let evidence_json = serde_json::to_string(&evidence)
        .map_err(|error| format!("Serialize printer wizard evidence: {error}"))?;

    let mut conn = db.conn.lock().map_err(|error| error.to_string())?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Begin printer wizard enqueue: {error}"))?;
    let shared_attempt_blocker = crate::print_dispatch::shared_attempt_blocker_predicate_sql("a");
    let duplicate_sql = format!(
        "SELECT j.id, j.status, j.entity_payload_json
             FROM print_jobs j
             WHERE j.entity_type = 'test_print'
               AND json_valid(j.entity_payload_json)
               AND json_extract(j.entity_payload_json, '$.targetKey') = ?1
               AND (
                 j.status IN ('pending', 'printing')
                 OR EXISTS (
                   SELECT 1 FROM print_job_attempts a
                   WHERE a.print_job_id = j.id
                     AND {shared_attempt_blocker}
                 )
               )
             ORDER BY j.created_at, j.id
             LIMIT 1"
    );
    let existing = transaction
        .query_row(&duplicate_sql, [&target_identity], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .optional()
        .map_err(|error| format!("Coalesce printer wizard sample: {error}"))?;
    if let Some((job_id, queue_state, payload_json)) = existing {
        transaction
            .commit()
            .map_err(|error| format!("Finish printer wizard coalescing: {error}"))?;
        return outcome_from_existing_wizard_job(job_id, queue_state, payload_json);
    }

    let job_id = Uuid::new_v4().hyphenated().to_string();
    let entity_id = format!(
        "printer_setup_sample:{}:{}",
        evidence["wizardSessionId"].as_str().unwrap_or_default(),
        evidence["sampleKind"].as_str().unwrap_or_default()
    );
    let now = Utc::now().to_rfc3339();
    transaction
        .execute(
            "INSERT INTO print_jobs (
                 id, entity_type, entity_id, entity_payload_json, printer_profile_id,
                 status, document_snapshot_version, document_snapshot_zlib,
                 document_snapshot_sha256, render_profile_snapshot_json,
                 created_at, updated_at
             ) VALUES (
                 ?1, 'test_print', ?2, ?3, ?4,
                 'pending', ?5, ?6, ?7, ?8, ?9, ?9
             )",
            params![
                &job_id,
                &entity_id,
                &evidence_json,
                request.saved_profile_id.as_deref(),
                encoded.version,
                &encoded.compressed,
                &encoded.sha256,
                &envelope_json,
                &now,
            ],
        )
        .map_err(|error| format!("Insert managed printer wizard sample: {error}"))?;
    before_commit()?;
    transaction
        .commit()
        .map_err(|error| format!("Commit managed printer wizard sample: {error}"))?;
    drop(conn);

    Ok(PreRenderedTestPrintOutcome {
        job_id,
        duplicate: false,
        queue_state: "pending".to_owned(),
        sample_kind: evidence["sampleKind"]
            .as_str()
            .unwrap_or("transport_text")
            .to_owned(),
        candidate_connection_details: evidence["candidateConnectionDetails"].clone(),
        candidate_capabilities: evidence["candidateCapabilities"].clone(),
        logo_configured: evidence["logoConfigured"].as_bool().unwrap_or(false),
        logo_included: evidence["logoIncluded"].as_bool().unwrap_or(false),
    })
}

pub(crate) fn enqueue_pre_rendered_test_print(
    db: &DbState,
    request: PreRenderedTestPrint,
) -> Result<PreRenderedTestPrintOutcome, String> {
    enqueue_pre_rendered_test_print_with_transaction_hook(db, request, || Ok(()))
}

#[cfg(test)]
pub(crate) fn enqueue_pre_rendered_test_print_with_hook(
    db: &DbState,
    request: PreRenderedTestPrint,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<PreRenderedTestPrintOutcome, String> {
    enqueue_pre_rendered_test_print_with_transaction_hook(db, request, before_commit)
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// List print jobs, optionally filtered by status.
#[cfg_attr(not(test), allow(dead_code))]
pub fn list_print_jobs(db: &DbState, status_filter: Option<&str>) -> Result<Value, String> {
    list_print_jobs_with_filters(db, status_filter, None)
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrintJobCapabilities {
    cancellable: bool,
    retryable: bool,
    reprintable: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrintQueueJobSnapshot {
    id: String,
    reprint_of_job_id: Option<String>,
    source: &'static str,
    entity_type: String,
    entity_id: String,
    printer_profile_id: Option<String>,
    printer_profile_name: Option<String>,
    printer_display_name: String,
    status: String,
    transport_state: Option<String>,
    resolved_transport: Option<String>,
    resolved_target: Option<String>,
    windows_job_id: Option<u32>,
    ownership_marker: Option<String>,
    native_status_bits: Option<u32>,
    native_status_text: Option<String>,
    retry_count: i32,
    max_retries: i32,
    next_retry_at: Option<String>,
    last_error: Option<String>,
    warning_code: Option<String>,
    warning_message: Option<String>,
    last_attempt_at: Option<String>,
    last_seen_at: Option<String>,
    created_at: String,
    updated_at: String,
    history_expires_at: Option<String>,
    snapshot_available: bool,
    paused: bool,
    capabilities: PrintJobCapabilities,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrintQueueCounts {
    active: usize,
    failed: usize,
    stale: usize,
    history: usize,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrintQueuePagination {
    offset: usize,
    limit: usize,
    total: usize,
    has_more: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrintQueueSnapshot {
    success: bool,
    jobs: Vec<PrintQueueJobSnapshot>,
    queue_paused: bool,
    paused_printer_profile_ids: Vec<String>,
    counts: PrintQueueCounts,
    pagination: PrintQueuePagination,
}

fn bounded_operational_text(value: Option<String>, max_chars: usize) -> Option<String> {
    let value = value?;
    let sanitized: String = value
        .trim()
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(max_chars)
        .collect();
    (!sanitized.is_empty()).then_some(sanitized)
}

fn validated_frozen_profile_display_name(
    envelope_json: Option<String>,
    entity_type: &str,
) -> Option<String> {
    let envelope = serde_json::from_str::<FrozenRenderEnvelope>(&envelope_json?).ok()?;
    envelope.validate(entity_type).ok()?;
    bounded_operational_text(Some(envelope.effective_profile_name), 160)
}

fn is_sensitive_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

fn is_pattern_boundary(bytes: &[u8], index: usize) -> bool {
    index == 0 || !matches!(bytes[index - 1], b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-')
}

fn earliest_sensitive_detail_byte(value: &str) -> Option<usize> {
    let lower = value.to_ascii_lowercase();
    let bytes = value.as_bytes();
    let lower_bytes = lower.as_bytes();
    let mut earliest = None;
    let mut record = |index: usize| {
        earliest = Some(earliest.map_or(index, |current: usize| current.min(index)));
    };

    for scheme in ["https://", "http://", "file://"] {
        if let Some(index) = lower.find(scheme) {
            record(index);
        }
    }

    for index in 0..bytes.len() {
        let boundary = is_pattern_boundary(bytes, index);
        let windows_drive = index + 2 < bytes.len()
            && bytes[index].is_ascii_alphabetic()
            && bytes[index + 1] == b':'
            && matches!(bytes[index + 2], b'/' | b'\\');
        let unc_path = index + 1 < bytes.len()
            && boundary
            && ((bytes[index] == b'\\' && bytes[index + 1] == b'\\')
                || (bytes[index] == b'/' && bytes[index + 1] == b'/'));
        let unix_path = boundary
            && bytes[index] == b'/'
            && bytes.get(index + 1).is_some_and(|next| *next != b'/');
        let home_path = boundary
            && bytes[index] == b'~'
            && bytes
                .get(index + 1)
                .is_some_and(|next| matches!(next, b'/' | b'\\'));
        if windows_drive || unc_path || unix_path || home_path {
            record(index);
        }
    }

    const SECRET_KEYS: &[&str] = &[
        "api_key",
        "api-key",
        "apikey",
        "access_token",
        "access-token",
        "refresh_token",
        "refresh-token",
        "client_secret",
        "client-secret",
        "authorization",
        "password",
        "passwd",
        "credential",
        "cookie",
        "session",
        "token",
        "secret",
    ];
    for key in SECRET_KEYS {
        let mut search_from = 0;
        while let Some(relative) = lower[search_from..].find(key) {
            let index = search_from + relative;
            let after_key = index + key.len();
            let boundary_before = is_pattern_boundary(lower_bytes, index);
            let boundary_after = after_key == lower_bytes.len()
                || !matches!(
                    lower_bytes[after_key],
                    b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'
                );
            let mut separator = after_key;
            while lower_bytes
                .get(separator)
                .is_some_and(|byte| byte.is_ascii_whitespace())
            {
                separator += 1;
            }
            if boundary_before
                && boundary_after
                && lower_bytes
                    .get(separator)
                    .is_some_and(|byte| matches!(byte, b'=' | b':'))
            {
                record(index);
            }
            search_from = after_key;
        }
    }

    let mut bearer_from = 0;
    while let Some(relative) = lower[bearer_from..].find("bearer") {
        let index = bearer_from + relative;
        let after = index + "bearer".len();
        if is_pattern_boundary(lower_bytes, index)
            && lower_bytes
                .get(after)
                .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            record(index);
        }
        bearer_from = after;
    }

    let mut token_start = None;
    for (index, character) in value
        .char_indices()
        .chain(std::iter::once((value.len(), ' ')))
    {
        if character.is_ascii() && is_sensitive_token_byte(character as u8) {
            token_start.get_or_insert(index);
            continue;
        }
        if let Some(start) = token_start.take() {
            let token = &value[start..index];
            let jwt_like = token.len() >= 20
                && token.bytes().filter(|byte| *byte == b'.').count() >= 2
                && token.bytes().all(is_sensitive_token_byte);
            let hex_like = token.len() >= 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit());
            let opaque_like = token.len() >= 40
                && token.bytes().all(is_sensitive_token_byte)
                && token.bytes().any(|byte| byte.is_ascii_alphabetic())
                && token.bytes().any(|byte| byte.is_ascii_digit());
            if jwt_like || hex_like || opaque_like {
                record(start);
            }
        }
    }

    earliest
}

/// Return only bounded, operationally useful error text. Once a path, URL,
/// credential, or opaque secret-like token is encountered, the entire
/// untrusted suffix is discarded so a malformed detail can never fail open.
pub(crate) fn safe_operational_error(value: Option<String>, max_chars: usize) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let value = value?;
    let normalized: String = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    if normalized.is_empty() {
        return None;
    }

    let sanitized = if let Some(index) = earliest_sensitive_detail_byte(&normalized) {
        let safe_prefix = normalized[..index]
            .trim_end_matches(|character: char| character.is_whitespace())
            .trim_end_matches(['=', '-', '(', '[']);
        if safe_prefix.is_empty() {
            "[redacted-sensitive-detail]".to_string()
        } else {
            format!("{safe_prefix} [redacted-sensitive-detail]")
        }
    } else {
        normalized
    };
    let bounded: String = sanitized.chars().take(max_chars).collect();
    (!bounded.trim().is_empty()).then_some(bounded)
}

fn active_attempt_predicate_sql(alias: &str) -> String {
    crate::print_dispatch::shared_attempt_blocker_predicate_sql(alias)
}

fn representative_attempt_order_sql(alias: &str) -> String {
    format!(
        "CASE WHEN {} THEN 0 ELSE 1 END, {alias}.attempt_number DESC",
        active_attempt_predicate_sql(alias)
    )
}

fn attempt_state_is_active_blocker(state: Option<&str>, spool_job_id: Option<i64>) -> bool {
    crate::print_dispatch::attempt_state_is_shared_blocker(state, spool_job_id)
}

fn snapshot_capabilities(
    parent_state: &str,
    transport_state: Option<&str>,
    spool_job_id: Option<i64>,
    live_registered: bool,
) -> PrintJobCapabilities {
    let active_transport = attempt_state_is_active_blocker(transport_state, spool_job_id);
    let cancellable = parent_state == "pending"
        || active_transport
        || (parent_state == "printing" && live_registered);
    PrintJobCapabilities {
        cancellable,
        // Retry/Reprint are enriched after the page statement is fully dropped
        // using the same all-attempt and source rules as the mutations.
        retryable: false,
        reprintable: false,
    }
}

struct InMemoryReadSnapshotGuard<'a> {
    conn: &'a rusqlite::Connection,
    previous_query_only: i64,
    armed: bool,
}

impl InMemoryReadSnapshotGuard<'_> {
    fn cleanup(&self) -> Result<(), String> {
        if !self.conn.is_autocommit() {
            self.conn
                .execute_batch("ROLLBACK;")
                .map_err(|error| format!("Close in-memory print queue read snapshot: {error}"))?;
        }
        self.conn
            .pragma_update(None, "query_only", self.previous_query_only)
            .map_err(|error| format!("Restore in-memory print queue read mode: {error}"))
    }

    fn finish(mut self) -> Result<(), String> {
        let result = self.cleanup();
        if result.is_ok() {
            self.armed = false;
        }
        result
    }
}

impl Drop for InMemoryReadSnapshotGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.cleanup();
        }
    }
}

fn with_print_queue_snapshot_reader<T, F>(db: &DbState, operation: F) -> Result<T, String>
where
    F: FnOnce(&rusqlite::Connection) -> Result<T, String>,
{
    if db.db_path == Path::new(":memory:") {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        let previous_query_only = conn
            .query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("Read in-memory print queue mode: {error}"))?;
        conn.pragma_update(None, "query_only", 1_i64)
            .map_err(|error| format!("Set in-memory print queue read mode: {error}"))?;
        let guard = InMemoryReadSnapshotGuard {
            conn: &conn,
            previous_query_only,
            armed: true,
        };
        conn.execute_batch("BEGIN DEFERRED;")
            .map_err(|error| format!("Start in-memory print queue read snapshot: {error}"))?;
        let result = operation(&conn);
        guard.finish()?;
        return result;
    }

    let reader = rusqlite::Connection::open_with_flags(
        &db.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| format!("Open print queue snapshot reader: {error}"))?;
    reader
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Configure print queue snapshot reader timeout: {error}"))?;
    reader
        .execute_batch("PRAGMA query_only = ON; BEGIN DEFERRED;")
        .map_err(|error| format!("Start print queue read snapshot: {error}"))?;
    let result = operation(&reader);
    reader
        .execute_batch("ROLLBACK;")
        .map_err(|error| format!("Close print queue read snapshot: {error}"))?;
    result
}

pub(crate) fn print_queue_snapshot(
    db: &DbState,
    status_filter: Option<&str>,
    printer_profile_filter: Option<&str>,
    requested_limit: usize,
    requested_offset: usize,
) -> Result<PrintQueueSnapshot, String> {
    let validation_scope = print_history_validation_scope(db)?;
    print_queue_snapshot_with_eligibility_evaluator(
        db,
        status_filter,
        printer_profile_filter,
        requested_limit,
        requested_offset,
        move |conn, job_id, now| {
            crate::print_history::print_history_eligibility_cached(
                conn,
                &validation_scope,
                job_id,
                now,
            )
        },
    )
}

fn print_queue_snapshot_with_eligibility_evaluator<F>(
    db: &DbState,
    status_filter: Option<&str>,
    printer_profile_filter: Option<&str>,
    requested_limit: usize,
    requested_offset: usize,
    eligibility_evaluator: F,
) -> Result<PrintQueueSnapshot, String>
where
    F: Fn(
        &rusqlite::Connection,
        &str,
        chrono::DateTime<Utc>,
    ) -> Result<crate::print_history::PrintHistoryEligibility, String>,
{
    let limit = requested_limit.clamp(1, 100);
    let offset = requested_offset;
    let active_owner_id = active_print_owner_id(db)?;
    let live_registered_job_ids = matching_active_print_job_ids_for_owner(&active_owner_id, None);
    with_print_queue_snapshot_reader(db, |conn| {
        let queue_paused = is_print_queue_paused_with_conn(conn, None);
        let paused_profiles = paused_printer_profiles(conn);

        let mut predicates = Vec::new();
        let mut binds = Vec::<String>::new();
        if let Some(status) = status_filter
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            binds.push(status.to_owned());
            predicates.push(format!("j.status = ?{}", binds.len()));
        }
        if let Some(profile_id) = printer_profile_filter
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            binds.push(profile_id.to_owned());
            predicates.push(format!("j.printer_profile_id = ?{}", binds.len()));
        }
        let where_clause = if predicates.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", predicates.join(" AND "))
        };
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM print_jobs j {where_clause}"),
                rusqlite::params_from_iter(binds.iter()),
                |row| row.get(0),
            )
            .map_err(|error| format!("Count safe print queue snapshot: {error}"))?;

        let representative_order = representative_attempt_order_sql("latest");
        let sql = format!(
            "SELECT
             j.id, j.entity_type, j.entity_id, j.printer_profile_id,
             j.status, j.retry_count, j.max_retries, j.next_retry_at,
             j.last_error, j.warning_code, j.warning_message, j.last_attempt_at,
             j.created_at, j.updated_at, j.history_expires_at,
             (j.document_snapshot_version IS NOT NULL
              AND j.document_snapshot_zlib IS NOT NULL
              AND COALESCE(j.document_snapshot_sha256, '') <> ''
              AND COALESCE(j.render_profile_snapshot_json, '') <> ''),
             p.name,
             a.id, a.transport, a.resolved_target, a.document_name,
             a.spool_job_id, a.state, a.native_status_bits,
             a.native_status_text, a.last_seen_at, a.last_error,
             j.reprint_of_job_id, j.render_profile_snapshot_json
         FROM print_jobs j
         LEFT JOIN printer_profiles p ON p.id = j.printer_profile_id
         LEFT JOIN print_job_attempts a ON a.id = (
             SELECT latest.id FROM print_job_attempts latest
             WHERE latest.print_job_id = j.id
             ORDER BY {representative_order} LIMIT 1
         )
         {where_clause}
         ORDER BY j.created_at DESC, j.id DESC
         LIMIT {limit} OFFSET {offset}"
        );
        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| format!("Prepare safe print queue snapshot: {error}"))?;
        let mut jobs = statement
            .query_map(rusqlite::params_from_iter(binds.iter()), |row| {
                let id = row.get::<_, String>(0)?;
                let profile_id = row.get::<_, Option<String>>(3)?;
                let parent_state = row.get::<_, String>(4)?;
                let attempt_id = row.get::<_, Option<String>>(17)?;
                let transport = row.get::<_, Option<String>>(18)?;
                let persisted_target = row.get::<_, Option<String>>(19)?;
                let persisted_marker = row.get::<_, Option<String>>(20)?;
                let spool_job_id_i64 = row.get::<_, Option<i64>>(21)?;
                let spool_job_id = spool_job_id_i64
                    .and_then(|value| u32::try_from(value).ok())
                    .filter(|value| *value != 0);
                let transport_state = row.get::<_, Option<String>>(22)?;
                let ownership_marker =
                    if transport.as_deref() == Some("windows") && spool_job_id.is_some() {
                        match (
                            attempt_id.as_deref(),
                            persisted_marker.as_deref(),
                            Uuid::parse_str(&id).ok(),
                        ) {
                            (Some(attempt_id), Some(marker), Some(job_uuid)) => {
                                crate::windows_spooler::parse_document_marker(marker)
                                    .ok()
                                    .filter(|parsed| {
                                        parsed.local_job_id == job_uuid
                                            && parsed.attempt_id.to_string() == attempt_id
                                    })
                                    .map(|_| marker.to_owned())
                            }
                            _ => None,
                        }
                    } else {
                        None
                    };
                let paused = queue_paused
                    || profile_id
                        .as_deref()
                        .is_some_and(|profile_id| paused_profiles.contains(profile_id));
                let capabilities = snapshot_capabilities(
                    &parent_state,
                    transport_state.as_deref(),
                    spool_job_id_i64,
                    live_registered_job_ids.contains(&id),
                );
                let attempt_error = row.get::<_, Option<String>>(26)?;
                let parent_error = row.get::<_, Option<String>>(8)?;
                let entity_type = row.get::<_, String>(1)?;
                let printer_profile_name = bounded_operational_text(row.get(16)?, 160);
                let printer_display_name = printer_profile_name
                    .clone()
                    .or_else(|| {
                        validated_frozen_profile_display_name(row.get(28).ok(), &entity_type)
                    })
                    .or_else(|| bounded_operational_text(persisted_target.clone(), 160))
                    .unwrap_or_else(|| "Printer".to_string());
                Ok(PrintQueueJobSnapshot {
                    id,
                    reprint_of_job_id: row.get(27)?,
                    source: "pos",
                    entity_type,
                    entity_id: row.get(2)?,
                    printer_profile_id: profile_id,
                    printer_profile_name,
                    printer_display_name,
                    status: parent_state,
                    transport_state,
                    resolved_transport: transport.clone(),
                    resolved_target: bounded_operational_text(persisted_target, 256),
                    windows_job_id: (transport.as_deref() == Some("windows"))
                        .then_some(spool_job_id)
                        .flatten(),
                    ownership_marker,
                    native_status_bits: row
                        .get::<_, Option<i64>>(23)?
                        .and_then(|value| u32::try_from(value).ok()),
                    native_status_text: bounded_operational_text(row.get(24)?, 256),
                    retry_count: row.get(5)?,
                    max_retries: row.get(6)?,
                    next_retry_at: row.get(7)?,
                    last_error: safe_operational_error(attempt_error.or(parent_error), 1024),
                    warning_code: bounded_operational_text(row.get(9)?, 128),
                    warning_message: safe_operational_error(row.get(10)?, 512),
                    last_attempt_at: row.get(11)?,
                    last_seen_at: row.get(25)?,
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                    history_expires_at: row.get(14)?,
                    snapshot_available: row.get::<_, i64>(15)? != 0,
                    paused,
                    capabilities,
                })
            })
            .map_err(|error| format!("Query safe print queue snapshot: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Read safe print queue snapshot: {error}"))?;
        drop(statement);

        let blocker_exists = format!(
            "EXISTS (
        SELECT 1 FROM print_job_attempts blocker
        WHERE blocker.print_job_id = print_jobs.id
          AND {}
    )",
            active_attempt_predicate_sql("blocker")
        );
        let max_windows_spool_job_id_sql = crate::print_dispatch::MAX_WINDOWS_SPOOL_JOB_ID_SQL;
        let unresolved_exists = format!(
            "EXISTS (
        SELECT 1 FROM print_job_attempts unresolved
        WHERE unresolved.print_job_id = print_jobs.id
          AND (
              unresolved.state IN ('unknown', 'cancel_failed')
              OR (unresolved.state = 'spool_error'
                  AND typeof(unresolved.spool_job_id) = 'integer'
                  AND unresolved.spool_job_id BETWEEN 1 AND {max_windows_spool_job_id_sql})
          )
    )"
        );
        let counts_sql = format!(
        "SELECT
             COALESCE(SUM(CASE WHEN status IN ('pending', 'printing') OR {blocker_exists}
                               THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN {unresolved_exists}
                                   OR (status = 'printing'
                                       AND julianday('now') - julianday(updated_at) > (30.0 / 86400.0)
                                       AND NOT {blocker_exists})
                              THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN status IN ('printed', 'dispatched', 'failed', 'cancelled')
                                   AND NOT {blocker_exists}
                              THEN 1 ELSE 0 END), 0)
         FROM print_jobs"
    );
        let (active, failed, stale, history): (i64, i64, i64, i64) = conn
            .query_row(&counts_sql, [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(|error| format!("Count safe print queue states: {error}"))?;
        let paused_printer_profile_ids = paused_profiles.into_iter().collect::<Vec<_>>();
        let total = usize::try_from(total).unwrap_or(usize::MAX);

        let eligibility_now = Utc::now();
        for job in &mut jobs {
            let eligibility = eligibility_evaluator(conn, &job.id, eligibility_now)?;
            job.capabilities.retryable = eligibility.retryable;
            job.capabilities.reprintable = eligibility.reprintable;
        }

        Ok(PrintQueueSnapshot {
            success: true,
            jobs,
            queue_paused,
            paused_printer_profile_ids,
            counts: PrintQueueCounts {
                active: usize::try_from(active).unwrap_or_default(),
                failed: usize::try_from(failed).unwrap_or_default(),
                stale: usize::try_from(stale).unwrap_or_default(),
                history: usize::try_from(history).unwrap_or_default(),
            },
            pagination: PrintQueuePagination {
                offset,
                limit,
                total,
                has_more: offset.saturating_add(limit) < total,
            },
        })
    })
}

pub fn list_print_jobs_with_filters(
    db: &DbState,
    status_filter: Option<&str>,
    printer_profile_filter: Option<&str>,
) -> Result<Value, String> {
    let snapshot = print_queue_snapshot(db, status_filter, printer_profile_filter, 100, 0)?;
    serde_json::to_value(snapshot.jobs).map_err(|error| error.to_string())
}

#[derive(Debug)]
struct DurablePauseCancelPlan {
    affected: usize,
    unchanged: usize,
    local_cancelled: usize,
    cooperative_job_ids: HashSet<String>,
    cooperative_only_job_ids: HashSet<String>,
    windows_attempt_ids: Vec<Uuid>,
}

type PauseCancelCandidate = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct NativeControlCounts {
    requested: usize,
    confirmed: usize,
    failed: usize,
    ownership_refused: usize,
    durable_changed: bool,
}

impl NativeControlCounts {
    fn merge_into(self, value: &mut Value) {
        let Some(object) = value.as_object_mut() else {
            return;
        };
        object.insert("nativeControlsRequested".into(), self.requested.into());
        object.insert("nativeControlsConfirmed".into(), self.confirmed.into());
        object.insert("nativeControlsFailed".into(), self.failed.into());
        object.insert("ownershipRefused".into(), self.ownership_refused.into());
        let durable_changed = object
            .get("durableChanged")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || self.durable_changed;
        object.insert("durableChanged".into(), durable_changed.into());
        if self.requested > 0 || self.durable_changed {
            object.insert("success".into(), true.into());
            let affected = object
                .get("affected")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            if affected == 0 {
                object.insert("affected".into(), 1.into());
                let unchanged = object
                    .get("unchanged")
                    .and_then(Value::as_u64)
                    .unwrap_or_default()
                    .saturating_sub(1);
                object.insert("unchanged".into(), unchanged.into());
            }
        }
    }
}

fn open_native_control_connection(path: &Path) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(path)
        .map_err(|error| format!("Open POS print control database: {error}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .map_err(|error| format!("Configure POS print control database: {error}"))?;
    Ok(conn)
}

fn record_native_control_failure_at_path(
    db_path: &Path,
    attempt_ids: &[Uuid],
    control: crate::windows_spooler::SpoolJobControl,
    reason: &str,
) -> bool {
    let Ok(conn) = open_native_control_connection(db_path) else {
        return false;
    };
    let mut durable_changed = false;
    for attempt_id in attempt_ids {
        durable_changed |= matches!(
            crate::print_dispatch::record_owned_windows_control_failure(
                &conn,
                *attempt_id,
                control,
                reason,
                Utc::now(),
            ),
            Ok(crate::print_dispatch::ApplyResult::Applied)
        );
    }
    durable_changed
}

fn execute_windows_controls_bounded<S>(
    db: &DbState,
    spooler: Arc<S>,
    attempt_ids: &[Uuid],
    control: crate::windows_spooler::SpoolJobControl,
    timeout: Duration,
) -> NativeControlCounts
where
    S: crate::windows_spooler::WindowsSpooler,
{
    let mut counts = NativeControlCounts::default();
    let mut groups: BTreeMap<String, Vec<Uuid>> = BTreeMap::new();
    let mut read_failures = Vec::new();
    {
        let conn = lock_conn_recovering(db);
        let mut unique = HashSet::new();
        for attempt_id in attempt_ids.iter().copied().filter(|id| unique.insert(*id)) {
            match crate::print_dispatch::read_attempt(&conn, attempt_id) {
                Ok(Some(attempt))
                    if attempt.transport == "windows"
                        && attempt.spool_job_id.is_some_and(|job_id| job_id > 0)
                        && !attempt.resolved_target.trim().is_empty() =>
                {
                    groups
                        .entry(attempt.resolved_target)
                        .or_default()
                        .push(attempt_id);
                }
                Ok(_) => counts.ownership_refused += 1,
                Err(crate::print_dispatch::DispatchError::InvalidWindowsJobId) => {
                    counts.ownership_refused += 1;
                }
                Err(_) => {
                    counts.failed += 1;
                    read_failures.push(attempt_id);
                }
            }
        }
    }
    if !read_failures.is_empty() {
        counts.durable_changed |= record_native_control_failure_at_path(
            &db.db_path,
            &read_failures,
            control,
            "native_control_database_read_failed",
        );
    }

    if groups.is_empty() {
        return counts;
    }
    let db_path = db.db_path.clone();
    let (group_tx, group_rx) = std::sync::mpsc::channel();
    let mut pending_groups = HashMap::<usize, Vec<Uuid>>::new();
    for (group_index, (_, group_attempt_ids)) in groups.into_iter().enumerate() {
        let worker_tx = group_tx.clone();
        let worker_db_path = db_path.clone();
        let worker_spooler = Arc::clone(&spooler);
        let pending_ids = group_attempt_ids.clone();
        let worker = std::thread::Builder::new()
            .name(format!("pos-print-control-{group_index}"))
            .spawn(move || {
                let cancel = Arc::new(AtomicBool::new(false));
                let worker_cancel = Arc::clone(&cancel);
                let ids_for_worker = group_attempt_ids.clone();
                let result = run_dispatch_with_timeout(timeout, cancel, move || {
                    let conn = open_native_control_connection(&worker_db_path)?;
                    let mut outcomes = Vec::with_capacity(ids_for_worker.len());
                    for attempt_id in ids_for_worker {
                        if worker_cancel.load(Ordering::Acquire) {
                            break;
                        }
                        let outcome =
                            crate::print_dispatch::control_owned_windows_attempt_with_cancel(
                                &conn,
                                worker_spooler.as_ref(),
                                attempt_id,
                                control,
                                Utc::now(),
                                worker_cancel.as_ref(),
                            )
                            .map_err(|error| error.to_string());
                        outcomes.push((attempt_id, outcome));
                    }
                    Ok::<_, String>(outcomes)
                });
                let _ = worker_tx.send((group_index, result));
            });
        match worker {
            Ok(_) => {
                pending_groups.insert(group_index, pending_ids);
            }
            Err(_) => {
                counts.failed += pending_ids.len();
                counts.durable_changed |= record_native_control_failure_at_path(
                    &db_path,
                    &pending_ids,
                    control,
                    "native_control_worker_start_failed",
                );
            }
        }
    }
    drop(group_tx);

    while !pending_groups.is_empty() {
        let Ok((group_index, result)) = group_rx.recv() else {
            let stranded = pending_groups
                .drain()
                .flat_map(|(_, attempt_ids)| attempt_ids)
                .collect::<Vec<_>>();
            counts.failed += stranded.len();
            counts.durable_changed |= record_native_control_failure_at_path(
                &db_path,
                &stranded,
                control,
                "native_control_worker_ended_without_result",
            );
            break;
        };
        let Some(group_attempt_ids) = pending_groups.remove(&group_index) else {
            continue;
        };
        match result {
            Ok(Ok(outcomes)) => {
                for (attempt_id, outcome) in outcomes {
                    match outcome {
                        Ok(crate::print_dispatch::OwnedWindowsControlResult::Requested) => {
                            counts.requested += 1;
                        }
                        Ok(crate::print_dispatch::OwnedWindowsControlResult::NotRequired) => {}
                        Ok(
                            crate::print_dispatch::OwnedWindowsControlResult::OwnershipNotConfirmed {
                                ..
                            },
                        ) => {
                            counts.ownership_refused += 1;
                            counts.durable_changed |= record_native_control_failure_at_path(
                                &db_path,
                                &[attempt_id],
                                control,
                                "native_job_ownership_not_confirmed",
                            );
                        }
                        Ok(crate::print_dispatch::OwnedWindowsControlResult::Failed { .. })
                        | Err(_) => {
                            counts.failed += 1;
                            counts.durable_changed |= record_native_control_failure_at_path(
                                &db_path,
                                &[attempt_id],
                                control,
                                "native_control_failed",
                            );
                        }
                    }
                }
            }
            Ok(Err(_)) | Err(_) => {
                counts.failed += group_attempt_ids.len();
                counts.durable_changed |= record_native_control_failure_at_path(
                    &db_path,
                    &group_attempt_ids,
                    control,
                    "native_control_timed_out_or_unavailable",
                );
            }
        }
    }
    counts
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct WindowsReconcileCounts {
    observed: usize,
    failed: usize,
}

fn record_reconciliation_failure_at_path(db_path: &Path, attempt_ids: &[Uuid], reason: &str) {
    let Ok(conn) = open_native_control_connection(db_path) else {
        return;
    };
    for attempt_id in attempt_ids {
        let _ = crate::print_dispatch::record_owned_windows_reconciliation_failure(
            &conn,
            *attempt_id,
            reason,
            Utc::now(),
        );
    }
}

fn reconcile_windows_attempts_bounded(
    db: &DbState,
    manager: &DispatchManager,
    spooler: Arc<dyn WindowsSpooler>,
    timeout: Duration,
) -> Result<WindowsReconcileCounts, String> {
    let reconciliation_owner_id = active_print_owner_id(db)?;
    let groups = {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        let reconciliation_sql = format!(
            "SELECT a.id, a.resolved_target
                 FROM print_job_attempts a
                 WHERE a.transport = 'windows'
                   AND typeof(a.spool_job_id) = 'integer'
                   AND a.spool_job_id BETWEEN 1 AND ?1
                   AND {}
                 ORDER BY a.resolved_target, a.started_at, a.attempt_number, a.id",
            active_attempt_predicate_sql("a"),
        );
        let mut statement = conn
            .prepare(&reconciliation_sql)
            .map_err(|error| format!("Prepare Windows queue reconciliation: {error}"))?;
        let rows = statement
            .query_map([i64::from(u32::MAX)], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("Query Windows queue reconciliation: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Read Windows queue reconciliation: {error}"))?;
        let mut groups: BTreeMap<String, Vec<Uuid>> = BTreeMap::new();
        for (attempt_id, target) in rows {
            if let Ok(attempt_id) = Uuid::parse_str(&attempt_id) {
                groups.entry(target).or_default().push(attempt_id);
            }
        }
        groups
    };

    if groups.is_empty() {
        return Ok(WindowsReconcileCounts::default());
    }
    let db_path = db.db_path.clone();
    let (group_tx, group_rx) = std::sync::mpsc::channel();
    let mut group_count = 0usize;
    for (resolved_target, group_attempt_ids) in groups {
        let Some(native_lease) =
            NativeReconciliationLease::try_acquire(&reconciliation_owner_id, &resolved_target)
        else {
            continue;
        };
        group_count += 1;
        let worker_db_path = db_path.clone();
        let worker_manager = manager.clone();
        let worker_spooler = Arc::clone(&spooler);
        let group_tx = group_tx.clone();
        std::thread::spawn(move || {
            let cancel = Arc::new(AtomicBool::new(false));
            let worker_cancel = Arc::clone(&cancel);
            let ids_for_worker = group_attempt_ids.clone();
            let result = run_dispatch_with_timeout(timeout, cancel, move || {
                // This lease deliberately lives in the actual native worker,
                // not the bounded caller. If GetJob outlives the timeout, the
                // same DbState/target cannot accumulate another native call.
                let _native_lease = native_lease;
                let conn = open_native_control_connection(&worker_db_path)?;
                let mut outcomes = Vec::with_capacity(ids_for_worker.len());
                for attempt_id in ids_for_worker {
                    if worker_cancel.load(Ordering::Acquire) {
                        break;
                    }
                    let outcome =
                        crate::print_dispatch::reconcile_owned_windows_attempt_with_cancel(
                            &conn,
                            &worker_manager,
                            worker_spooler.as_ref(),
                            attempt_id,
                            Utc::now(),
                            worker_cancel.as_ref(),
                        )
                        .map_err(|error| error.to_string());
                    outcomes.push(outcome);
                }
                Ok::<_, String>(outcomes)
            });
            let _ = group_tx.send((group_attempt_ids, result));
        });
    }
    drop(group_tx);

    if group_count == 0 {
        return Ok(WindowsReconcileCounts::default());
    }

    let mut counts = WindowsReconcileCounts::default();
    for _ in 0..group_count {
        let (attempt_ids, result) = group_rx
            .recv()
            .map_err(|_| "Windows reconciliation worker ended without a result".to_string())?;
        match result {
            Ok(Ok(outcomes)) => {
                for outcome in outcomes {
                    match outcome {
                        Ok(crate::print_dispatch::OwnedWindowsReconcileResult {
                            outcome:
                                crate::print_dispatch::OwnedWindowsReconcileOutcome::Failed { .. },
                            ..
                        })
                        | Err(_) => counts.failed += 1,
                        Ok(_) => counts.observed += 1,
                    }
                }
            }
            Ok(Err(_)) | Err(_) => {
                counts.failed += attempt_ids.len();
                record_reconciliation_failure_at_path(
                    &db_path,
                    &attempt_ids,
                    "native_reconciliation_timed_out_or_unavailable",
                );
            }
        }
    }
    Ok(counts)
}

fn durable_pause_and_cancel_pos_jobs_with_conn(
    conn: &rusqlite::Connection,
    printer_profile_id: Option<&str>,
    additional_job_ids: &HashSet<String>,
    now: chrono::DateTime<Utc>,
) -> Result<DurablePauseCancelPlan, String> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|error| format!("Begin atomic POS print cancellation: {error}"))?;
    let pause_key = print_queue_pause_key(printer_profile_id);
    db::set_setting(&tx, PRINT_QUEUE_SETTINGS_CATEGORY, &pause_key, "true")?;

    let all_active = active_attempt_predicate_sql("a");
    let scoped_sql = format!(
        "SELECT j.id, j.status, a.id, a.transport, a.state, a.spool_job_id
             FROM print_jobs j
             LEFT JOIN print_job_attempts a
               ON a.print_job_id = j.id
              AND {all_active}
             WHERE j.printer_profile_id = ?1
               AND (j.status IN ('pending', 'printing') OR a.id IS NOT NULL)
             ORDER BY j.created_at, j.id, a.attempt_number, a.id"
    );
    let global_sql = format!(
        "SELECT j.id, j.status, a.id, a.transport, a.state, a.spool_job_id
             FROM print_jobs j
             LEFT JOIN print_job_attempts a
               ON a.print_job_id = j.id
              AND {all_active}
             WHERE j.status IN ('pending', 'printing') OR a.id IS NOT NULL
             ORDER BY j.created_at, j.id, a.attempt_number, a.id"
    );
    let mut statement = match printer_profile_id {
        Some(_) => tx.prepare(&scoped_sql),
        None => tx.prepare(&global_sql),
    }
    .map_err(|error| format!("Prepare atomic POS print cancellation: {error}"))?;
    let mut candidates: Vec<PauseCancelCandidate> = match printer_profile_id {
        Some(profile_id) => statement
            .query_map([profile_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .map_err(|error| format!("Query scoped POS print cancellation: {error}"))?
            .collect::<Result<_, _>>()
            .map_err(|error| format!("Read scoped POS print cancellation: {error}"))?,
        None => statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .map_err(|error| format!("Query POS print cancellation: {error}"))?
            .collect::<Result<_, _>>()
            .map_err(|error| format!("Read POS print cancellation: {error}"))?,
    };
    drop(statement);
    let mut seen_job_ids: HashSet<String> = candidates
        .iter()
        .map(|candidate| candidate.0.clone())
        .collect();
    for job_id in additional_job_ids {
        if !seen_job_ids.insert(job_id.clone()) {
            continue;
        }
        let active_sql = format!(
            "SELECT j.id, j.status, a.id, a.transport, a.state, a.spool_job_id
             FROM print_jobs j
             LEFT JOIN print_job_attempts a
               ON a.print_job_id = j.id
              AND {}
             WHERE j.id = ?1
             ORDER BY a.attempt_number, a.id",
            active_attempt_predicate_sql("a")
        );
        let mut additional_statement = tx.prepare(&active_sql).map_err(|error| {
            format!("Prepare active registered POS print cancellation: {error}")
        })?;
        let additional = additional_statement
            .query_map([job_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .map_err(|error| format!("Query active registered POS print cancellation: {error}"))?
            .collect::<Result<Vec<PauseCancelCandidate>, _>>()
            .map_err(|error| format!("Read active registered POS print cancellation: {error}"))?;
        drop(additional_statement);
        candidates.extend(additional);
    }

    let now_text = now.to_rfc3339();
    let mut plan = DurablePauseCancelPlan {
        affected: 0,
        unchanged: 0,
        local_cancelled: 0,
        cooperative_job_ids: HashSet::new(),
        cooperative_only_job_ids: HashSet::new(),
        windows_attempt_ids: Vec::new(),
    };
    let active_windows_job_ids = candidates
        .iter()
        .filter_map(|(job_id, _, _, transport, attempt_state, spool_job_id)| {
            (transport.as_deref() == Some("windows")
                && spool_job_id.is_some()
                && attempt_state_is_active_blocker(attempt_state.as_deref(), *spool_job_id))
            .then_some(job_id.clone())
        })
        .collect::<HashSet<_>>();
    let mut changed_windows_job_ids = HashSet::new();
    let mut handled_non_windows_job_ids = HashSet::new();
    let mut finalized_nonwindows_job_ids: HashSet<String> = HashSet::new();
    for (job_id, parent_state, attempt_id, transport, attempt_state, spool_job_id) in candidates {
        // Same dead-worker finalization as the single-job cancel (see
        // durable_cancel_print_job): raw/serial transports have no spooler
        // oracle, so an attempt a dead worker parked in a blocker state
        // ('unknown' after a mid-write network failure) never resolves and
        // bricks its printer lane across restarts. The bulk cancel is an
        // operator resolution too. In production `additional_job_ids` carries
        // the live-registered set — live workers keep the cooperative flow.
        let nonwindows_blocker = transport
            .as_deref()
            .is_some_and(|transport| transport != "windows")
            && attempt_state_is_active_blocker(attempt_state.as_deref(), spool_job_id);
        if nonwindows_blocker && !additional_job_ids.contains(&job_id) {
            let Some(attempt_uuid) = attempt_id
                .as_deref()
                .and_then(|value| Uuid::parse_str(value).ok())
            else {
                return Err("Active non-Windows attempt has an invalid identity".into());
            };
            let changed = tx
                .execute(
                    "UPDATE print_job_attempts
                     SET state = 'cancelled',
                         cancel_requested_at = COALESCE(cancel_requested_at, ?1),
                         completed_at = COALESCE(completed_at, ?1),
                         last_seen_at = CASE
                             WHEN last_seen_at IS NULL OR last_seen_at <= ?1 THEN ?1
                             ELSE last_seen_at
                         END
                     WHERE id = ?2 AND state IN (
                         'created', 'submitting', 'paused', 'cancel_requested',
                         'unknown', 'cancel_failed'
                     )",
                    params![now_text, attempt_uuid.to_string()],
                )
                .map_err(|error| format!("Finalize dead non-Windows POS attempt: {error}"))?;
            if changed == 1 {
                finalized_nonwindows_job_ids.insert(job_id.clone());
            }
        }
        let active_windows = transport.as_deref() == Some("windows")
            && spool_job_id.is_some()
            && attempt_state_is_active_blocker(attempt_state.as_deref(), spool_job_id);
        if active_windows {
            let Some(attempt_id) = attempt_id
                .as_deref()
                .and_then(|value| Uuid::parse_str(value).ok())
            else {
                return Err("Active Windows attempt has an invalid identity".into());
            };
            let changed = tx
                .execute(
                    "UPDATE print_job_attempts
                     SET state = 'cancel_requested',
                         cancel_requested_at = COALESCE(cancel_requested_at, ?1),
                         last_seen_at = CASE
                             WHEN last_seen_at IS NULL OR last_seen_at <= ?1 THEN ?1
                             ELSE last_seen_at
                         END
                     WHERE id = ?2 AND state IN (
                         'windows_queued', 'windows_printing', 'paused',
                         'unknown', 'cancel_failed', 'spool_error'
                     )",
                    params![now_text, attempt_id.to_string()],
                )
                .map_err(|error| format!("Request durable Windows cancellation: {error}"))?;
            if changed == 1 {
                changed_windows_job_ids.insert(job_id.clone());
            }
            plan.cooperative_job_ids.insert(job_id);
            plan.windows_attempt_ids.push(attempt_id);
            continue;
        }

        if active_windows_job_ids.contains(&job_id)
            || !handled_non_windows_job_ids.insert(job_id.clone())
        {
            continue;
        }

        if finalized_nonwindows_job_ids.contains(&job_id) {
            // The blocker rows are finalized; close a parent that never
            // reached a terminal state, keep a 'failed' parent's history and
            // warning untouched.
            let parent_closed = if parent_state == "pending" || parent_state == "printing" {
                tx.execute(
                    "UPDATE print_jobs
                     SET status = 'cancelled',
                         warning_code = 'operator_cancelled',
                         warning_message = 'POS print cancelled after its transport worker died with an unconfirmed result',
                         completed_at = ?1,
                         history_expires_at = datetime(?1, '+30 days'),
                         updated_at = ?1
                     WHERE id = ?2 AND status = ?3",
                    params![now_text, job_id, parent_state],
                )
                .map_err(|error| format!("Close parent of finalized POS attempt: {error}"))?
            } else {
                0
            };
            plan.affected += 1;
            plan.local_cancelled += parent_closed;
            continue;
        }

        let has_active_attempt =
            attempt_state_is_active_blocker(attempt_state.as_deref(), spool_job_id);
        if parent_state == "pending" && !has_active_attempt {
            let changed = tx
                .execute(
                    "UPDATE print_jobs
                     SET status = 'cancelled',
                         warning_code = 'operator_cancelled',
                         warning_message = 'Pending POS print cancelled before transport submission',
                         completed_at = ?1,
                         history_expires_at = datetime(?1, '+30 days'),
                         updated_at = ?1
                     WHERE id = ?2 AND status = 'pending'",
                    params![now_text, job_id],
                )
                .map_err(|error| format!("Cancel local pending POS print: {error}"))?;
            plan.affected += changed;
            plan.local_cancelled += changed;
            if changed == 0 {
                plan.unchanged += 1;
            }
            if additional_job_ids.contains(&job_id) {
                plan.cooperative_job_ids.insert(job_id);
            }
        } else if has_active_attempt || additional_job_ids.contains(&job_id) {
            plan.cooperative_job_ids.insert(job_id.clone());
            plan.cooperative_only_job_ids.insert(job_id);
        } else {
            plan.unchanged += 1;
        }
    }
    plan.affected += changed_windows_job_ids.len();
    plan.unchanged += active_windows_job_ids
        .difference(&changed_windows_job_ids)
        .count();
    plan.windows_attempt_ids.sort_unstable();
    tx.commit()
        .map_err(|error| format!("Commit atomic POS print cancellation: {error}"))?;
    Ok(plan)
}

#[cfg(test)]
fn durable_pause_and_cancel_pos_jobs(
    db: &DbState,
    printer_profile_id: Option<&str>,
    now: chrono::DateTime<Utc>,
) -> Result<DurablePauseCancelPlan, String> {
    let _profile_guard = printer_profile_id.map(|_| {
        profile_association_coordination()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    });
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    durable_pause_and_cancel_pos_jobs_with_conn(&conn, printer_profile_id, &HashSet::new(), now)
}

fn durable_set_pause_and_select_windows_attempts(
    db: &DbState,
    printer_profile_id: Option<&str>,
    paused: bool,
) -> Result<Vec<Uuid>, String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate)
        .map_err(|error| format!("Begin durable print queue pause change: {error}"))?;
    db::set_setting(
        &tx,
        PRINT_QUEUE_SETTINGS_CATEGORY,
        &print_queue_pause_key(printer_profile_id),
        if paused { "true" } else { "false" },
    )?;
    let eligible_states = if paused {
        "'windows_queued', 'windows_printing'"
    } else {
        "'windows_queued', 'windows_printing', 'paused'"
    };
    let profile_predicate = if printer_profile_id.is_some() {
        "AND j.printer_profile_id = ?1"
    } else {
        ""
    };
    let max_windows_spool_job_id_sql = crate::print_dispatch::MAX_WINDOWS_SPOOL_JOB_ID_SQL;
    let sql = format!(
        "SELECT a.id
         FROM print_jobs j
         JOIN print_job_attempts a ON a.print_job_id = j.id
         WHERE a.transport = 'windows'
           AND typeof(a.spool_job_id) = 'integer'
           AND a.spool_job_id BETWEEN 1 AND {max_windows_spool_job_id_sql}
           AND a.state IN ({eligible_states})
           {profile_predicate}
         ORDER BY a.resolved_target, a.attempt_number, a.id"
    );
    let mut statement = tx
        .prepare(&sql)
        .map_err(|error| format!("Prepare scoped Windows pause controls: {error}"))?;
    let attempt_ids: Vec<Uuid> = match printer_profile_id {
        Some(profile_id) => statement
            .query_map([profile_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Query scoped Windows pause controls: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Read scoped Windows pause controls: {error}"))?,
        None => statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Query Windows pause controls: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Read Windows pause controls: {error}"))?,
    }
    .into_iter()
    .filter_map(|value| Uuid::parse_str(&value).ok())
    .collect();
    drop(statement);
    tx.commit()
        .map_err(|error| format!("Commit durable print queue pause change: {error}"))?;
    Ok(attempt_ids)
}

fn set_print_queue_paused_with_spooler<S>(
    db: &DbState,
    printer_profile_id: Option<&str>,
    paused: bool,
    spooler: Arc<S>,
    timeout: Duration,
) -> Result<Value, String>
where
    S: crate::windows_spooler::WindowsSpooler,
{
    let active_owner_id = paused.then(|| active_print_owner_id(db)).transpose()?;
    let association_guard = profile_association_coordination()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let attempt_ids =
        durable_set_pause_and_select_windows_attempts(db, printer_profile_id, paused)?;
    let active_stops_requested = if paused {
        request_active_print_stops_for_owner(
            active_owner_id.as_deref().expect("paused owner preflight"),
            None,
            printer_profile_id,
        )
        .len()
    } else {
        0
    };
    drop(association_guard);

    let control = if paused {
        crate::windows_spooler::SpoolJobControl::Pause
    } else {
        crate::windows_spooler::SpoolJobControl::Resume
    };
    let counts = execute_windows_controls_bounded(db, spooler, &attempt_ids, control, timeout);
    let conn = lock_conn_recovering(db);
    let paused_profiles: Vec<String> = paused_printer_profiles(&conn).into_iter().collect();
    let queue_paused = is_print_queue_paused_with_conn(&conn, None);
    drop(conn);
    let mut response = serde_json::json!({
        "success": true,
        "durableChanged": true,
        "queuePaused": queue_paused,
        "pausedPrinterProfileIds": paused_profiles,
        "printerProfileId": printer_profile_id,
        "activeStopsRequested": active_stops_requested,
        "nativeControlsRequested": 0,
        "nativeControlsConfirmed": 0,
        "nativeControlsFailed": 0,
        "ownershipRefused": 0,
    });
    counts.merge_into(&mut response);
    Ok(response)
}

pub fn set_print_queue_paused(
    db: &DbState,
    printer_profile_id: Option<&str>,
    paused: bool,
) -> Result<Value, String> {
    set_print_queue_paused_with_spooler(
        db,
        printer_profile_id,
        paused,
        Arc::new(SystemWindowsSpooler),
        NATIVE_QUEUE_CONTROL_TIMEOUT,
    )
}

fn durable_cancel_print_job(db: &DbState, job_id: &str) -> Result<Value, String> {
    let active_owner_id = active_print_owner_id(db)?;
    // Keep exact live-registry membership, the durable transition, and the
    // token request in one association window. A profile-scoped worker cannot
    // move into or out of this pre-attempt gap between those phases.
    let association_guard = profile_association_coordination()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let live_registered = active_print_job_is_registered_for_owner(&active_owner_id, job_id);
    let now = Utc::now();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate)
        .map_err(|error| format!("Begin POS print cancellation: {error}"))?;
    let all_active = active_attempt_predicate_sql("a");
    let mut statement = tx
        .prepare(&format!(
            "SELECT j.status, a.id, a.transport, a.state, a.spool_job_id
             FROM print_jobs j
             LEFT JOIN print_job_attempts a
               ON a.print_job_id = j.id
              AND {all_active}
             WHERE j.id = ?1
             ORDER BY a.attempt_number, a.id"
        ))
        .map_err(|error| format!("Prepare POS print cancellation candidates: {error}"))?;
    let candidates = statement
        .query_map([job_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .map_err(|error| format!("Query POS print cancellation candidates: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Read POS print cancellation candidates: {error}"))?;
    drop(statement);
    if candidates.is_empty() {
        return Ok(serde_json::json!({
            "success": false,
            "durableChanged": false,
            "affected": 0,
            "unchanged": 1,
            "localCancelled": 0,
            "activeStopsRequested": 0,
            "nativeControlsRequested": 0,
            "nativeControlsConfirmed": 0,
            "nativeControlsFailed": 0,
            "ownershipRefused": 0,
        }));
    }
    let now_text = now.to_rfc3339();
    let parent_state = &candidates[0].0;
    let mut windows_attempt_ids = Vec::new();
    let mut durable_changed = false;
    for (_, attempt_id, transport, attempt_state, spool_job_id) in &candidates {
        let active_windows = transport.as_deref() == Some("windows")
            && spool_job_id.is_some()
            && attempt_state_is_active_blocker(attempt_state.as_deref(), *spool_job_id);
        if !active_windows {
            continue;
        }
        let Some(attempt_id) = attempt_id
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok())
        else {
            return Err("Active Windows attempt has an invalid identity".into());
        };
        let changed = tx
            .execute(
                "UPDATE print_job_attempts
                 SET state = 'cancel_requested',
                     cancel_requested_at = COALESCE(cancel_requested_at, ?1),
                     last_seen_at = CASE
                         WHEN last_seen_at IS NULL OR last_seen_at <= ?1 THEN ?1
                         ELSE last_seen_at
                     END
                 WHERE id = ?2 AND state IN (
                     'windows_queued', 'windows_printing', 'paused',
                     'unknown', 'cancel_failed', 'spool_error'
                 )",
                params![now_text, attempt_id.to_string()],
            )
            .map_err(|error| format!("Request durable Windows cancellation: {error}"))?;
        durable_changed |= changed == 1;
        windows_attempt_ids.push(attempt_id);
    }
    let has_active_attempt = candidates.iter().any(|(_, _, _, state, spool_job_id)| {
        attempt_state_is_active_blocker(state.as_deref(), *spool_job_id)
    });
    // The print-deadlock of 19/08 (live at the shop): a raw TCP receipt died
    // mid-write (90112/109831 bytes, os error 10060) and parked its attempt
    // in 'unknown' as the worker's dying act. There is no spooler oracle for
    // raw/serial transports, so nothing ever resolves that row — yet it keeps
    // counting as the printer lane's active blocker, and hydration re-retains
    // the lane after every restart. The operator card says "check the
    // physical printer before retrying manually", which makes CANCEL the
    // designed resolution — so cancel must be able to finalize a dead
    // non-Windows attempt. Guarded on !live_registered: an attempt whose
    // worker is still alive keeps the cooperative-stop flow, and Windows
    // attempts keep cancel_requested (their spooler CAN still answer).
    let mut dead_nonwindows_finalized = 0usize;
    if windows_attempt_ids.is_empty() && !live_registered {
        for (_, attempt_id, transport, attempt_state, spool_job_id) in &candidates {
            let is_dead_nonwindows_blocker = transport
                .as_deref()
                .is_some_and(|transport| transport != "windows")
                && attempt_state_is_active_blocker(attempt_state.as_deref(), *spool_job_id);
            if !is_dead_nonwindows_blocker {
                continue;
            }
            let Some(attempt_id) = attempt_id
                .as_deref()
                .and_then(|value| Uuid::parse_str(value).ok())
            else {
                return Err("Active non-Windows attempt has an invalid identity".into());
            };
            let changed = tx
                .execute(
                    "UPDATE print_job_attempts
                     SET state = 'cancelled',
                         cancel_requested_at = COALESCE(cancel_requested_at, ?1),
                         completed_at = COALESCE(completed_at, ?1),
                         last_seen_at = CASE
                             WHEN last_seen_at IS NULL OR last_seen_at <= ?1 THEN ?1
                             ELSE last_seen_at
                         END
                     WHERE id = ?2 AND state IN (
                         'created', 'submitting', 'paused', 'cancel_requested',
                         'unknown', 'cancel_failed'
                     )",
                    params![now_text, attempt_id.to_string()],
                )
                .map_err(|error| format!("Finalize dead non-Windows POS attempt: {error}"))?;
            dead_nonwindows_finalized += usize::from(changed == 1);
        }
        durable_changed |= dead_nonwindows_finalized > 0;
    }
    let (affected, unchanged, local_cancelled, request_stop) = if !windows_attempt_ids.is_empty() {
        (
            usize::from(durable_changed),
            usize::from(!durable_changed),
            0,
            true,
        )
    } else if dead_nonwindows_finalized > 0 {
        // The lane's durable blockers are gone; if the parent never reached a
        // terminal state, close it as operator-cancelled so it stops counting
        // as active. A parent already 'failed' keeps its status and warning —
        // the history card still tells the unknown-transport story.
        let parent_closed = if parent_state == "pending" || parent_state == "printing" {
            tx.execute(
                "UPDATE print_jobs
                 SET status = 'cancelled',
                     warning_code = 'operator_cancelled',
                     warning_message = 'POS print cancelled after its transport worker died with an unconfirmed result',
                     completed_at = ?1,
                     history_expires_at = datetime(?1, '+30 days'),
                     updated_at = ?1
                 WHERE id = ?2 AND status = ?3",
                params![now_text, job_id, parent_state],
            )
            .map_err(|error| format!("Close parent of finalized POS attempt: {error}"))?
        } else {
            0
        };
        (dead_nonwindows_finalized, 0, parent_closed, false)
    } else if !has_active_attempt && parent_state == "pending" {
        let changed = tx
            .execute(
                "UPDATE print_jobs
                 SET status = 'cancelled',
                     warning_code = 'operator_cancelled',
                     warning_message = 'Pending POS print cancelled before transport submission',
                     completed_at = ?1,
                     history_expires_at = datetime(?1, '+30 days'),
                     updated_at = ?1
                 WHERE id = ?2 AND status = ?3",
                params![now_text, job_id, parent_state],
            )
            .map_err(|error| format!("Cancel local pending POS print: {error}"))?;
        (changed, usize::from(changed == 0), changed, live_registered)
    } else if has_active_attempt || (parent_state == "printing" && live_registered) {
        (0, 1, 0, true)
    } else {
        (0, 1, 0, false)
    };
    tx.commit()
        .map_err(|error| format!("Commit POS print cancellation: {error}"))?;
    drop(conn);
    let active_stops_requested = if request_stop {
        request_active_print_stops_for_owner(&active_owner_id, Some(job_id), None).len()
    } else {
        0
    };
    drop(association_guard);
    let cooperative_only_applied =
        windows_attempt_ids.is_empty() && affected == 0 && active_stops_requested > 0;
    let affected = affected + usize::from(cooperative_only_applied);
    let unchanged = unchanged.saturating_sub(usize::from(cooperative_only_applied));
    Ok(serde_json::json!({
        "success": affected > 0,
        "durableChanged": durable_changed || local_cancelled > 0,
        "affected": affected,
        "unchanged": unchanged,
        "localCancelled": local_cancelled,
        "activeStopsRequested": active_stops_requested,
        "nativeControlsRequested": 0,
        "nativeControlsConfirmed": 0,
        "nativeControlsFailed": 0,
        "ownershipRefused": 0,
    }))
}

fn cancel_print_job_with_spooler<S>(
    db: &DbState,
    job_id: &str,
    spooler: Arc<S>,
    timeout: Duration,
) -> Result<Value, String>
where
    S: crate::windows_spooler::WindowsSpooler,
{
    let mut response = durable_cancel_print_job(db, job_id)?;
    let attempt_ids = {
        let conn = lock_conn_recovering(db);
        match conn
            .prepare(
                "SELECT a.id
             FROM print_job_attempts a
             WHERE a.print_job_id = ?1
               AND a.transport = 'windows'
               AND a.spool_job_id IS NOT NULL
               AND a.state = 'cancel_requested'
             ORDER BY a.resolved_target, a.attempt_number, a.id",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(params![job_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            }) {
            Ok(values) => values
                .into_iter()
                .filter_map(|value| Uuid::parse_str(&value).ok())
                .collect::<Vec<_>>(),
            Err(_) => {
                if let Some(object) = response.as_object_mut() {
                    object.insert("nativeControlsFailed".into(), 1.into());
                }
                return Ok(response);
            }
        }
    };
    let counts = execute_windows_controls_bounded(
        db,
        spooler,
        &attempt_ids,
        crate::windows_spooler::SpoolJobControl::Delete,
        timeout,
    );
    counts.merge_into(&mut response);
    Ok(response)
}

pub fn cancel_print_job(db: &DbState, job_id: &str) -> Result<Value, String> {
    cancel_print_job_with_spooler(
        db,
        job_id,
        Arc::new(SystemWindowsSpooler),
        NATIVE_QUEUE_CONTROL_TIMEOUT,
    )
}

fn pause_and_cancel_pos_jobs_with_spooler<S>(
    db: &DbState,
    printer_profile_id: Option<&str>,
    spooler: Arc<S>,
    timeout: Duration,
) -> Result<Value, String>
where
    S: crate::windows_spooler::WindowsSpooler,
{
    let active_owner_id = active_print_owner_id(db)?;
    // Cover both the durable selection and the cooperative-token request with
    // the same association barrier. A worker cannot slip a newly resolved
    // profile into the gap between those two phases.
    let association_guard = profile_association_coordination()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let active_registered_job_ids =
        matching_active_print_job_ids_for_owner(&active_owner_id, printer_profile_id);
    let plan = {
        let conn = lock_conn_recovering(db);
        durable_pause_and_cancel_pos_jobs_with_conn(
            &conn,
            printer_profile_id,
            &active_registered_job_ids,
            Utc::now(),
        )?
    };
    let stopped_job_ids = request_active_print_stops_for_job_ids_and_owner(
        &active_owner_id,
        &plan.cooperative_job_ids,
    );
    let cooperative_only_stops = stopped_job_ids
        .intersection(&plan.cooperative_only_job_ids)
        .count();
    let affected = plan.affected + cooperative_only_stops;
    let unchanged = plan.unchanged
        + plan
            .cooperative_only_job_ids
            .len()
            .saturating_sub(cooperative_only_stops);
    let active_stops_requested = stopped_job_ids.len();
    drop(association_guard);

    let counts = execute_windows_controls_bounded(
        db,
        spooler,
        &plan.windows_attempt_ids,
        crate::windows_spooler::SpoolJobControl::Delete,
        timeout,
    );
    let mut response = serde_json::json!({
        "success": true,
        "durableChanged": true,
        "affected": affected,
        "unchanged": unchanged,
        "localCancelled": plan.local_cancelled,
        "activeStopsRequested": active_stops_requested,
        "printerProfileId": printer_profile_id,
        "nativeControlsRequested": 0,
        "nativeControlsConfirmed": 0,
        "nativeControlsFailed": 0,
        "ownershipRefused": 0,
    });
    counts.merge_into(&mut response);
    Ok(response)
}

pub fn pause_and_cancel_pos_jobs(
    db: &DbState,
    printer_profile_id: Option<&str>,
    requested_statuses: Option<&[String]>,
) -> Result<Value, String> {
    if requested_statuses.is_some_and(|statuses| {
        !statuses.is_empty()
            && !statuses.iter().any(|status| {
                matches!(
                    status.trim().to_ascii_lowercase().as_str(),
                    "pending" | "printing" | "dispatched"
                )
            })
    }) {
        return Err("No cancellable print job statuses were provided".into());
    }
    pause_and_cancel_pos_jobs_with_spooler(
        db,
        printer_profile_id,
        Arc::new(SystemWindowsSpooler),
        NATIVE_QUEUE_CONTROL_TIMEOUT,
    )
}

// ---------------------------------------------------------------------------
// Status updates
// ---------------------------------------------------------------------------

/// Test-only fixture: force a job into the `dispatched` state.
///
/// Production reaches `dispatched` only through
/// `DispatchManager::finalize_attempt_and_parent` with
/// `ParentTransition::Dispatched`, which runs the same UPDATE inside the attempt's
/// transaction and additionally requires the row to be `printing` with this attempt as
/// the latest one. This standalone version accepts `pending` too and ignores attempts, so
/// shipping it would leave a way to complete a job without settling its attempt -- the
/// split-write shape that stranded jobs in `printing`. Retained behind cfg(test) because
/// tests for neighbouring live features (`list_print_jobs`, `set_print_job_warning`)
/// need a job in a successful state without driving a full managed dispatch.
#[cfg(test)]
pub fn mark_print_job_dispatched(
    db: &DbState,
    job_id: &str,
    output_path: &str,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let affected = conn
        .execute(
            "UPDATE print_jobs SET status = 'dispatched', output_path = ?1,
                    last_attempt_at = ?2, completed_at = ?2,
                    history_expires_at = datetime(?2, '+30 days'),
                    updated_at = ?2
             WHERE id = ?3 AND status IN ('pending', 'printing')",
            params![output_path, now, job_id],
        )
        .map_err(|e| format!("mark dispatched: {e}"))?;

    if affected == 0 {
        return Err(format!(
            "Print job {job_id} not found or not in printable state"
        ));
    }

    info!(job_id = %job_id, "Print job marked dispatched");
    Ok(())
}

/// Set a non-fatal warning on a print job (e.g. drawer kick failed).
///
/// This does NOT change the job's status — it stays in its current successful state.
/// Warnings are
/// surfaced in the job list for operational visibility.
pub fn set_print_job_warning(
    db: &DbState,
    job_id: &str,
    warning_code: &str,
    warning_message: &str,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE print_jobs SET warning_code = ?1, warning_message = ?2, updated_at = ?3
         WHERE id = ?4",
        params![warning_code, warning_message, now, job_id],
    )
    .map_err(|e| format!("set warning: {e}"))?;

    warn!(
        job_id = %job_id,
        code = %warning_code,
        "Print job warning set"
    );
    Ok(())
}

/// Test-only fixture: record a retryable failure and advance the retry counter.
///
/// The escalation contract this encodes (retry_count += 1, back to `pending` until
/// `max_retries`, exponential `next_retry_at`, terminal `failed` on the last attempt) is
/// live production behaviour -- but production runs it through
/// `ParentTransition::RetryableFailure` inside `finalize_attempt_and_parent`, which holds
/// the identical UPDATE. The shipped contract is pinned against that live path by
/// `retryable_failure_escalates_to_failed_at_max_retries` below; this fixture stays only
/// so tests of neighbouring features can age a job cheaply.
#[cfg(test)]
pub fn mark_print_job_failed(db: &DbState, job_id: &str, error_msg: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE print_jobs SET
            status = CASE
                WHEN retry_count + 1 >= max_retries THEN 'failed'
                ELSE 'pending'
            END,
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
         WHERE id = ?3 AND status = 'printing'",
        params![error_msg, now, job_id],
    )
    .map_err(|e| format!("mark failed: {e}"))?;

    warn!(job_id = %job_id, error = %error_msg, "Print job failed");
    Ok(())
}

/// Test-only fixture: force a job into the terminal `failed` state.
///
/// Superseded in production by `ParentTransition::ManualFailure`, which carries the
/// identical UPDATE inside `finalize_attempt_and_parent`. See
/// [`mark_print_job_dispatched`] for why the standalone form must not ship.
#[cfg(test)]
pub fn mark_print_job_failed_non_retryable(
    db: &DbState,
    job_id: &str,
    error_msg: &str,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE print_jobs SET
            status = 'failed',
            retry_count = retry_count + 1,
            last_error = ?1,
            last_attempt_at = ?2,
            next_retry_at = NULL,
            completed_at = ?2,
            history_expires_at = datetime(?2, '+30 days'),
            updated_at = ?2
         WHERE id = ?3 AND status = 'printing'",
        params![error_msg, now, job_id],
    )
    .map_err(|e| format!("mark failed non-retryable: {e}"))?;

    warn!(
        job_id = %job_id,
        error = %error_msg,
        "Print job failed (non-retryable)"
    );
    Ok(())
}

/// Lock the shared DB connection, recovering from mutex poisoning.
///
/// A poisoned mutex only means a *previous* thread panicked while holding the
/// guard; the underlying SQLite `Connection` is intact. The print worker
/// recovers the guard instead of permanently bricking the queue on the first
/// panic-under-guard anywhere in the process.
fn lock_conn_recovering(db: &DbState) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
    db.conn
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Select up to `limit` pending print jobs that are ready to run (past any retry
/// backoff), **excluding paused printer profiles in SQL**.
///
/// The exclusion must happen inside the query, before `LIMIT`: applying it in
/// Rust after a `LIMIT 10` lets a paused printer's backlog of >= 10 older
/// pending rows fill the whole window, so every healthy printer's newer jobs
/// are silently starved and never printed. Jobs with a NULL profile are always
/// eligible.
fn select_ready_pending_jobs(
    conn: &rusqlite::Connection,
    now_str: &str,
    paused_profiles: &std::collections::HashSet<String>,
    limit: usize,
) -> Result<Vec<(String, String, String, Option<String>, Option<String>)>, String> {
    let mut sql = String::from(
        "SELECT id, entity_type, entity_id, entity_payload_json, printer_profile_id FROM print_jobs
         WHERE status = 'pending'
           AND (next_retry_at IS NULL OR julianday(next_retry_at) <= julianday(?1))",
    );

    let paused: Vec<&String> = paused_profiles.iter().collect();
    if !paused.is_empty() {
        // ?1 is now_str; paused ids bind starting at ?2.
        let placeholders = (0..paused.len())
            .map(|i| format!("?{}", i + 2))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(
            " AND (printer_profile_id IS NULL OR printer_profile_id NOT IN ({placeholders}))"
        ));
    }
    sql.push_str(&format!(" ORDER BY created_at ASC LIMIT {limit}"));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    // Positional binds: ?1 = now_str, ?2.. = paused profile ids.
    let mut binds: Vec<String> = Vec::with_capacity(1 + paused.len());
    binds.push(now_str.to_string());
    for profile in &paused {
        binds.push((*profile).clone());
    }

    let rows = stmt
        .query_map(rusqlite::params_from_iter(binds.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Run a blocking hardware-dispatch closure under a hard wall-clock timeout.
///
/// `print_raw_to_windows` (the default Windows spooler transport) has no timeout
/// of its own. This isolates the blocking call
/// on its own thread and abandons the wait after `timeout`. On timeout the
/// orphaned thread is left to unwind whenever the transport finally returns (or
/// at process exit) and the caller fails the job closed, so a receipt that may
/// already have printed is never silently re-sent.
fn run_dispatch_with_timeout<T, F>(
    timeout: std::time::Duration,
    cancel: Arc<AtomicBool>,
    f: F,
) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // If the receiver already timed out and was dropped, this send is a
        // harmless no-op.
        let _ = tx.send(f());
    });
    match rx.recv_timeout(timeout) {
        Ok(value) => Ok(value),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            cancel.store(true, Ordering::Release);
            Err(DISPATCH_TIMEOUT_ERROR.to_string())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            cancel.store(true, Ordering::Release);
            Err("Print dispatch thread ended without a result".to_string())
        }
    }
}

fn setting_text(conn: &rusqlite::Connection, category: &str, key: &str) -> Option<String> {
    crate::db::get_setting(conn, category, key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_setting_bool(raw: Option<&str>) -> bool {
    matches!(
        raw.unwrap_or_default().trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub(crate) fn setting_bool(conn: &rusqlite::Connection, category: &str, key: &str) -> bool {
    parse_setting_bool(setting_text(conn, category, key).as_deref())
}

fn print_queue_pause_key(printer_profile_id: Option<&str>) -> String {
    match printer_profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(printer_profile_id) => {
            format!("{PRINT_QUEUE_PAUSED_PROFILE_PREFIX}{printer_profile_id}")
        }
        None => PRINT_QUEUE_PAUSED_GLOBAL_KEY.to_string(),
    }
}

fn paused_printer_profiles(conn: &rusqlite::Connection) -> HashSet<String> {
    let mut paused = HashSet::new();
    let mut stmt = match conn.prepare(
        "SELECT setting_key, setting_value
         FROM local_settings
         WHERE setting_category = ?1
           AND setting_key LIKE ?2",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return paused,
    };

    let rows = match stmt.query_map(
        params![
            PRINT_QUEUE_SETTINGS_CATEGORY,
            format!("{PRINT_QUEUE_PAUSED_PROFILE_PREFIX}%")
        ],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
    ) {
        Ok(rows) => rows,
        Err(_) => return paused,
    };

    for row in rows.flatten() {
        if !parse_setting_bool(row.1.as_deref()) {
            continue;
        }
        if let Some(profile_id) = row.0.strip_prefix(PRINT_QUEUE_PAUSED_PROFILE_PREFIX) {
            let profile_id = profile_id.trim();
            if !profile_id.is_empty() {
                paused.insert(profile_id.to_string());
            }
        }
    }

    paused
}

fn is_print_queue_paused_with_conn(
    conn: &rusqlite::Connection,
    printer_profile_id: Option<&str>,
) -> bool {
    if setting_bool(
        conn,
        PRINT_QUEUE_SETTINGS_CATEGORY,
        PRINT_QUEUE_PAUSED_GLOBAL_KEY,
    ) {
        return true;
    }

    match printer_profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(printer_profile_id) => setting_bool(
            conn,
            PRINT_QUEUE_SETTINGS_CATEGORY,
            &print_queue_pause_key(Some(printer_profile_id)),
        ),
        None => false,
    }
}

fn parse_number(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return Some(number);
    }
    if let Some(number) = value.as_i64() {
        return Some(number as f64);
    }
    if let Some(text) = value.as_str() {
        return text.trim().parse::<f64>().ok();
    }
    None
}

fn parse_bool(value: &Value) -> Option<bool> {
    if let Some(flag) = value.as_bool() {
        return Some(flag);
    }
    if let Some(number) = value.as_i64() {
        return Some(number != 0);
    }
    if let Some(text) = value.as_str() {
        let normalized = text.trim().to_ascii_lowercase();
        if matches!(normalized.as_str(), "1" | "true" | "yes" | "on") {
            return Some(true);
        }
        if matches!(normalized.as_str(), "0" | "false" | "no" | "off") {
            return Some(false);
        }
    }
    None
}

fn value_from_keys<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        if let Some(found) = value.get(*key) {
            return Some(found);
        }
    }
    None
}

fn text_from_keys(value: &Value, keys: &[&str]) -> Option<String> {
    value_from_keys(value, keys)
        .and_then(Value::as_str)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn number_from_keys(value: &Value, keys: &[&str]) -> Option<f64> {
    value_from_keys(value, keys).and_then(parse_number)
}

fn bool_from_keys(value: &Value, keys: &[&str]) -> bool {
    value_from_keys(value, keys)
        .and_then(parse_bool)
        .unwrap_or(false)
}

fn looks_like_customization_object(value: &Value) -> bool {
    if !value.is_object() {
        return false;
    }
    value.get("ingredient").is_some()
        || value.get("name").is_some()
        || value.get("name_en").is_some()
        || value.get("name_el").is_some()
        || value.get("label").is_some()
        || value.get("optionName").is_some()
        || value.get("isWithout").is_some()
        || value.get("is_without").is_some()
        || value.get("without").is_some()
        || value.get("price").is_some()
}

fn flatten_customization_values(value: &Value) -> Vec<Value> {
    if let Some(array) = value.as_array() {
        return array.clone();
    }
    if value.is_object() {
        if looks_like_customization_object(value) {
            return vec![value.clone()];
        }
        if let Some(object) = value.as_object() {
            return object.values().cloned().collect();
        }
    }
    if let Some(raw) = value.as_str() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return flatten_customization_values(&parsed);
        }
    }
    Vec::new()
}

fn extract_customization_name(entry: &Value) -> Option<String> {
    if let Some(ingredient) = entry.get("ingredient") {
        if let Some(name) = text_from_keys(ingredient, &["name", "name_en", "name_el"]) {
            return Some(name);
        }
    }
    text_from_keys(
        entry,
        &["name", "name_en", "name_el", "label", "optionName"],
    )
}

fn extract_customization_price(entry: &Value, is_without: bool) -> Option<f64> {
    if is_without {
        return None;
    }

    if let Some(ingredient) = entry.get("ingredient") {
        if let Some(price) = number_from_keys(
            ingredient,
            &[
                "price",
                "pickup_price",
                "delivery_price",
                "base_price",
                "additionalPrice",
                "extra_price",
            ],
        )
        .filter(|value| *value > 0.0)
        {
            return Some(price);
        }
    }

    number_from_keys(
        entry,
        &[
            "price",
            "pickup_price",
            "delivery_price",
            "base_price",
            "additionalPrice",
            "extra_price",
        ],
    )
    .filter(|value| *value > 0.0)
}

fn parse_customization_entries(raw: &Value) -> Vec<ReceiptCustomizationLine> {
    flatten_customization_values(raw)
        .into_iter()
        .filter_map(|entry| {
            let name = extract_customization_name(&entry)?;
            let is_without = bool_from_keys(&entry, &["isWithout", "is_without", "without"]);
            let quantity = number_from_keys(&entry, &["quantity", "qty"])
                .filter(|value| *value > 0.0)
                .unwrap_or(1.0);
            let is_little = bool_from_keys(&entry, &["isLittle", "is_little", "little"]);
            let price = extract_customization_price(&entry, is_without);
            Some(ReceiptCustomizationLine {
                name,
                quantity,
                is_without,
                is_little,
                price,
            })
        })
        .collect()
}

fn parse_item_customizations(item: &Value) -> Vec<ReceiptCustomizationLine> {
    for key in [
        "customizations",
        "modifiers",
        "ingredients",
        "selectedIngredients",
    ] {
        if let Some(raw) = item.get(key) {
            // Platform orders mirror server rows where `customizations` is an
            // object wrapping the actual list ({"modifiers":[{name,price}],
            // "external_sku":…}) — the materials live one level down.
            let raw = if raw.is_object() {
                raw.get("modifiers").unwrap_or(raw)
            } else {
                raw
            };
            let parsed = parse_customization_entries(raw);
            if !parsed.is_empty() {
                return parsed;
            }
        }
    }
    Vec::new()
}

fn parse_item_total(item: &Value) -> f64 {
    item.get("totalPrice")
        .or_else(|| item.get("total_price"))
        .or_else(|| item.get("price"))
        .or_else(|| item.get("unitPrice"))
        .and_then(parse_number)
        .unwrap_or(0.0)
}

#[derive(Debug, Default, Clone)]
struct MenuSubcategoryEntry {
    name: String,
    category_id: Option<String>,
    category_name: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct MenuCategoryLookup {
    categories_by_id: HashMap<String, String>,
    subcategories_by_id: HashMap<String, MenuSubcategoryEntry>,
}

#[derive(Debug, Default, Clone)]
struct ReceiptItemCategoryFields {
    category_name: Option<String>,
    subcategory_name: Option<String>,
    category_path: Option<String>,
}

fn normalized_lookup_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

fn parse_cached_menu_section(conn: &rusqlite::Connection, key: &str) -> Vec<Value> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT data FROM menu_cache WHERE cache_key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok();
    raw.and_then(|data| serde_json::from_str::<Value>(&data).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn build_menu_category_lookup(conn: &rusqlite::Connection) -> MenuCategoryLookup {
    let mut lookup = MenuCategoryLookup::default();

    for category in parse_cached_menu_section(conn, "categories") {
        let id = text_from_keys(&category, &["id", "category_id", "categoryId"]);
        let name = text_from_keys(&category, &["name", "name_el", "name_en", "title", "label"]);
        if let (Some(id), Some(name)) = (id, name) {
            if let Some(key) = normalized_lookup_key(&id) {
                lookup.categories_by_id.insert(key, name);
            }
        }
    }

    for subcategory in parse_cached_menu_section(conn, "subcategories") {
        let id = text_from_keys(
            &subcategory,
            &["id", "subcategory_id", "subcategoryId", "menu_item_id"],
        );
        let name = text_from_keys(
            &subcategory,
            &[
                "name",
                "name_el",
                "name_en",
                "title",
                "label",
                "menu_item_name",
            ],
        );
        let category_id = text_from_keys(
            &subcategory,
            &[
                "category_id",
                "categoryId",
                "parent_category_id",
                "menu_category_id",
            ],
        );
        let category_name = text_from_keys(&subcategory, &["category_name", "categoryName"]);
        if let (Some(id), Some(name)) = (id, name) {
            if let Some(key) = normalized_lookup_key(&id) {
                lookup.subcategories_by_id.insert(
                    key,
                    MenuSubcategoryEntry {
                        name,
                        category_id,
                        category_name,
                    },
                );
            }
        }
    }

    lookup
}

fn compose_category_path(
    category_name: Option<&str>,
    subcategory_name: Option<&str>,
) -> Option<String> {
    let category = category_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let subcategory = subcategory_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match (category, subcategory) {
        (Some(category), Some(subcategory)) => {
            if category.eq_ignore_ascii_case(subcategory) {
                Some(category.to_string())
            } else {
                Some(format!("{category} > {subcategory}"))
            }
        }
        (Some(category), None) => Some(category.to_string()),
        (None, Some(subcategory)) => Some(subcategory.to_string()),
        (None, None) => None,
    }
}

fn resolve_item_category_fields(
    item: &Value,
    lookup: &MenuCategoryLookup,
) -> ReceiptItemCategoryFields {
    let mut category_name = text_from_keys(item, &["category_name", "categoryName"]);
    let mut subcategory_name = text_from_keys(
        item,
        &[
            "subcategory_name",
            "subcategoryName",
            "sub_category_name",
            "subCategoryName",
            "menu_item_name",
            "menuItemName",
        ],
    );
    let mut category_path = text_from_keys(item, &["category_path", "categoryPath"]);

    let menu_item_id = text_from_keys(item, &["menu_item_id", "menuItemId"]);
    if let Some(id) = menu_item_id.and_then(|value| normalized_lookup_key(&value)) {
        if let Some(entry) = lookup.subcategories_by_id.get(&id) {
            if subcategory_name.is_none() {
                subcategory_name = Some(entry.name.clone());
            }
            if category_name.is_none() {
                category_name = entry.category_name.clone();
            }
            if category_name.is_none() {
                if let Some(category_id) =
                    entry.category_id.as_deref().and_then(normalized_lookup_key)
                {
                    category_name = lookup.categories_by_id.get(&category_id).cloned();
                }
            }
        }
    }

    if category_path.is_none() {
        category_path =
            compose_category_path(category_name.as_deref(), subcategory_name.as_deref());
    }

    ReceiptItemCategoryFields {
        category_name,
        subcategory_name,
        category_path,
    }
}

fn extract_last4_digits(input: &str) -> Option<String> {
    let digits: String = input.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if digits.len() >= 4 {
        digits.get(digits.len() - 4..).map(ToString::to_string)
    } else {
        None
    }
}

fn extract_masked_card_reference(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let has_mask_marker = trimmed.chars().any(|ch| matches!(ch, '*' | 'x' | 'X'));
    let has_last4_marker = trimmed.to_ascii_lowercase().contains("last4");
    if !has_mask_marker && !has_last4_marker {
        return None;
    }

    extract_last4_digits(trimmed).map(|last4| format!("****{last4}"))
}

fn title_case_payment_method(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mapped = match trimmed.to_ascii_lowercase().as_str() {
        "cash" => return Some("Cash".to_string()),
        "card" => return Some("Card".to_string()),
        _ => trimmed,
    };

    let mut words = Vec::new();
    for part in mapped
        .split(|ch: char| ch == '_' || ch == '-' || ch.is_whitespace())
        .filter(|part| !part.is_empty())
    {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            let mut word = String::new();
            word.push(first.to_ascii_uppercase());
            word.push_str(chars.as_str().to_ascii_lowercase().as_str());
            words.push(word);
        }
    }

    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}

fn fallback_payment_line_from_order_snapshot(
    payment_method: &str,
    payment_status: &str,
    total_amount: f64,
) -> Option<PaymentLine> {
    let trimmed_method = payment_method.trim();
    if trimmed_method.is_empty() {
        return None;
    }

    let normalized_method = trimmed_method.to_ascii_lowercase();
    let label = title_case_payment_method(trimmed_method)?;
    if payment_status.trim().eq_ignore_ascii_case("paid")
        && matches!(normalized_method.as_str(), "cash" | "card")
    {
        Some(PaymentLine {
            label,
            amount: total_amount,
            detail: None,
        })
    } else {
        Some(PaymentLine {
            label,
            amount: 0.0,
            detail: Some(PAYMENT_DETAIL_AMOUNT_UNKNOWN.to_string()),
        })
    }
}

fn push_unique_trimmed_note(target: &mut Vec<String>, value: Option<&str>) {
    let Some(trimmed) = value.map(str::trim).filter(|entry| !entry.is_empty()) else {
        return;
    };
    if target
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(trimmed))
    {
        return;
    }
    target.push(trimmed.to_string());
}

fn build_item_note_text(item: &Value) -> Option<String> {
    let mut notes: Vec<String> = Vec::new();
    push_unique_trimmed_note(
        &mut notes,
        item.get("notes")
            .or_else(|| item.get("note"))
            .and_then(Value::as_str),
    );
    push_unique_trimmed_note(
        &mut notes,
        item.get("special_instructions")
            .or_else(|| item.get("specialInstructions"))
            .and_then(Value::as_str),
    );
    push_unique_trimmed_note(
        &mut notes,
        item.get("instructions")
            .or_else(|| item.get("instruction"))
            .and_then(Value::as_str),
    );
    if notes.is_empty() {
        None
    } else {
        Some(notes.join(" | "))
    }
}

pub fn resolve_layout_config(
    db: &DbState,
    profile: &Value,
    entity_type: &str,
) -> Result<LayoutConfig, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let receipt_like_entity = is_receipt_like_entity_type(entity_type);
    let paper_mm = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(Value::as_i64)
        .unwrap_or(80) as i32;
    let profile_template = profile
        .get("receiptTemplate")
        .or_else(|| profile.get("receipt_template"))
        .and_then(Value::as_str);
    let template_override = setting_text(&conn, "receipt", "template_override");
    let template = if let Some(value) = template_override.as_deref() {
        ReceiptTemplate::from_value(Some(value))
    } else if receipt_like_entity && profile_template.is_none() {
        ReceiptTemplate::Classic
    } else {
        ReceiptTemplate::from_value(profile_template)
    };
    if let Some(override_value) = template_override.as_deref() {
        info!(
            entity_type = %entity_type,
            template_override = %override_value,
            profile_template = ?profile_template,
            "Using explicit receipt template override from local settings"
        );
    }

    let organization_name_setting = setting_text(&conn, "organization", "name");
    let restaurant_name_setting = setting_text(&conn, "restaurant", "name");
    let terminal_store_name_setting = setting_text(&conn, "terminal", "store_name");
    let organization_name = organization_name_setting
        .clone()
        .or_else(|| restaurant_name_setting.clone())
        .or_else(|| terminal_store_name_setting.clone())
        .unwrap_or_else(|| "The Small".to_string());

    let restaurant_subtitle_setting = setting_text(&conn, "restaurant", "subtitle");
    let organization_subtitle_setting = setting_text(&conn, "organization", "subtitle");
    let store_subtitle = restaurant_subtitle_setting
        .clone()
        .or_else(|| {
            restaurant_name_setting.clone().and_then(|name| {
                if name.trim() != organization_name.trim() {
                    Some(name)
                } else {
                    None
                }
            })
        })
        .or_else(|| organization_subtitle_setting.clone());
    let store_address = setting_text(&conn, "restaurant", "address")
        .or_else(|| setting_text(&conn, "terminal", "store_address"));
    let store_phone = setting_text(&conn, "restaurant", "phone")
        .or_else(|| setting_text(&conn, "terminal", "store_phone"));
    let currency_symbol = setting_text(&conn, "receipt", "currency_symbol")
        .or_else(|| setting_text(&conn, "organization", "currency_symbol"))
        .or_else(|| {
            // Default currency symbol based on language when not explicitly set
            let lang = setting_text(&conn, "general", "language").unwrap_or_default();
            match lang.as_str() {
                "el" | "de" | "fr" | "it" | "es" | "pt" | "nl" => Some(" \u{20AC}".to_string()),
                _ => None,
            }
        })
        .unwrap_or_default();
    let vat_number = setting_text(&conn, "organization", "vat_number")
        .or_else(|| setting_text(&conn, "restaurant", "vat_number"));
    let tax_office = setting_text(&conn, "organization", "tax_office");
    let footer_text = setting_text(&conn, "receipt", "footer_text")
        .or_else(|| setting_text(&conn, "restaurant", "receipt_footer"))
        .or(Some("Thank you".to_string()));
    let qr_data = setting_text(&conn, "receipt", "qr_url")
        .or_else(|| setting_text(&conn, "restaurant", "website"));
    let show_qr_code = setting_bool(&conn, "receipt", "show_qr_code");
    let mut show_logo = setting_bool(&conn, "receipt", "show_logo");
    let logo_url = setting_text(&conn, "receipt", "logo_source")
        .or_else(|| setting_text(&conn, "organization", "logo_url"));
    let copy_label = setting_text(&conn, "receipt", "copy_label").or_else(|| {
        if entity_type == "kitchen_ticket" {
            None
        } else {
            setting_text(&conn, "receipt", "copy_type").map(|value| value.to_ascii_uppercase())
        }
    });
    // --- Auto-detection: brand, character set, code page ---
    let printer_name = profile
        .get("printerName")
        .or_else(|| profile.get("printer_name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let detected_brand = printers::detect_printer_brand_for_profile(profile);
    let capability_snapshot = printers::read_capability_snapshot(profile);
    let verification_status = printers::capability_verification_status(profile);

    let connection_json_value = profile
        .get("connectionJson")
        .or_else(|| profile.get("connection_json"))
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let connection = connection_json_value.as_ref().and_then(Value::as_object);
    let connection_type = connection
        .and_then(|obj| obj.get("type"))
        .and_then(Value::as_str)
        .or_else(|| {
            profile
                .get("printerType")
                .or_else(|| profile.get("printer_type"))
                .and_then(Value::as_str)
        })
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "system".to_string());
    let raw_transport_printer = matches!(
        connection_type.as_str(),
        "network" | "wifi" | "usb" | "bluetooth"
    );

    let parse_u16 = |value: Option<&Value>| -> Option<u16> {
        match value {
            Some(Value::Number(n)) => n.as_u64().map(|v| v as u16),
            Some(Value::String(s)) => s.trim().parse::<u16>().ok(),
            _ => None,
        }
    };
    let parse_u8 = |value: Option<&Value>| -> Option<u8> {
        match value {
            Some(Value::Number(n)) => n.as_u64().map(|v| v as u8),
            Some(Value::String(s)) => s.trim().parse::<u8>().ok(),
            _ => None,
        }
    };

    let setting_render_mode = setting_text(&conn, "receipt", "classic_customer_render_mode");
    let profile_render_mode = connection
        .and_then(|obj| obj.get("render_mode"))
        .and_then(Value::as_str);
    let capability_override_active = matches!(
        capability_snapshot.status.as_str(),
        "verified" | "degraded" | "candidate"
    );
    let verified_render_mode = if capability_override_active {
        capability_snapshot.render_mode.as_deref()
    } else {
        None
    };
    let classic_customer_render_mode = if let Some(value) = verified_render_mode {
        ClassicCustomerRenderMode::from_value(Some(value))
    } else if let Some(value) = setting_render_mode.as_deref() {
        ClassicCustomerRenderMode::from_value(Some(value))
    } else if let Some(value) = profile_render_mode {
        ClassicCustomerRenderMode::from_value(Some(value))
    } else if receipt_like_entity && raw_transport_printer && !capability_override_active {
        ClassicCustomerRenderMode::Text
    } else if receipt_like_entity {
        ClassicCustomerRenderMode::RasterExact
    } else {
        ClassicCustomerRenderMode::Text
    };
    let emulation_setting = connection
        .and_then(|obj| obj.get("emulation"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let emulation_mode = if capability_override_active {
        capability_snapshot
            .emulation
            .as_deref()
            .map(|value| ReceiptEmulationMode::from_value(Some(value)))
            .or_else(|| {
                emulation_setting.map(|value| ReceiptEmulationMode::from_value(Some(value)))
            })
            .unwrap_or_else(|| {
                if raw_transport_printer {
                    // Star printers need Auto so is_star_line_mode() returns
                    // true based on detected brand.  Standard ESC/POS commands
                    // (GS !, GS V, ESC t) produce garbled output on Star.
                    if detected_brand == crate::printers::PrinterBrand::Star {
                        ReceiptEmulationMode::Auto
                    } else {
                        ReceiptEmulationMode::Escpos
                    }
                } else {
                    ReceiptEmulationMode::from_value(emulation_setting)
                }
            })
    } else if let Some(value) = emulation_setting {
        // A saved operator choice is authoritative even when the printer has
        // not completed capability verification. Ignoring an explicit
        // `star_line` choice and falling back to ESC/POS sends incompatible
        // commands to mC-Print3 queues and can render the raster payload as
        // pages of gibberish.
        ReceiptEmulationMode::from_value(Some(value))
    } else if raw_transport_printer {
        // Star printers need Auto so is_star_line_mode() returns true based
        // on detected brand, even when the profile is not yet verified.
        if detected_brand == crate::printers::PrinterBrand::Star {
            ReceiptEmulationMode::Auto
        } else {
            ReceiptEmulationMode::Escpos
        }
    } else {
        ReceiptEmulationMode::from_value(emulation_setting)
    };

    let physical_width_dots = match paper_mm {
        w if w <= 58 => 384u16,
        w if w >= 100 => 832u16,
        _ => 576u16,
    };
    let mut printable_width_dots = physical_width_dots;
    printable_width_dots = parse_u16(connection.and_then(|obj| obj.get("printable_width_dots")))
        .unwrap_or(printable_width_dots)
        .clamp(64, physical_width_dots.max(64));
    let requested_left_margin = parse_u16(connection.and_then(|obj| obj.get("left_margin_dots")))
        .unwrap_or(0)
        .min(200);
    let max_left_margin = physical_width_dots.saturating_sub(printable_width_dots);
    let left_margin_dots = requested_left_margin.min(max_left_margin);
    let raster_threshold = parse_u8(connection.and_then(|obj| obj.get("threshold")))
        .unwrap_or(160)
        .clamp(40, 240);

    let profile_command_profile = profile
        .get("commandProfile")
        .or_else(|| profile.get("command_profile"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let configured_command_profile =
        setting_text(&conn, "receipt", "command_profile").or(profile_command_profile);
    let command_profile = configured_command_profile
        .as_deref()
        .map(|value| CommandProfile::from_value(Some(value)))
        .unwrap_or_else(|| {
            if detected_brand == crate::printers::PrinterBrand::Star {
                CommandProfile::SafeText
            } else {
                CommandProfile::FullStyle
            }
        });

    let requested_font_type = profile
        .get("fontType")
        .or_else(|| profile.get("font_type"))
        .and_then(Value::as_str)
        .map(|value| FontType::from_value(Some(value)))
        .unwrap_or(FontType::A);
    let requested_layout_density = profile
        .get("layoutDensity")
        .or_else(|| profile.get("layout_density"))
        .and_then(Value::as_str)
        .map(|value| LayoutDensity::from_value(Some(value)))
        .unwrap_or(LayoutDensity::Compact);
    let requested_header_emphasis = profile
        .get("headerEmphasis")
        .or_else(|| profile.get("header_emphasis"))
        .and_then(Value::as_str)
        .map(|value| HeaderEmphasis::from_value(Some(value)))
        .unwrap_or(HeaderEmphasis::Strong);
    let lock_classic_ticket_typography =
        entity_type == "kitchen_ticket" && template == ReceiptTemplate::Classic;
    let font_type = if lock_classic_ticket_typography {
        FontType::A
    } else {
        requested_font_type
    };
    let layout_density = if lock_classic_ticket_typography {
        LayoutDensity::Compact
    } else {
        requested_layout_density
    };
    let header_emphasis = if lock_classic_ticket_typography {
        HeaderEmphasis::Strong
    } else {
        requested_header_emphasis
    };

    let app_language = setting_text(&conn, "general", "language").unwrap_or_default();
    // Known brands (Star, Epson) support logo raster even if the profile
    // hasn't been verified yet.  Only suppress logo for truly unknown printers
    // where we can't be sure the firmware handles raster images.
    let brand_supports_logo = matches!(
        detected_brand,
        crate::printers::PrinterBrand::Star | crate::printers::PrinterBrand::Epson
    );
    let receipt_like_raster_logo = receipt_like_entity
        && template == ReceiptTemplate::Classic
        && classic_customer_render_mode == ClassicCustomerRenderMode::RasterExact;
    if receipt_like_entity
        && !receipt_like_raster_logo
        && !capability_snapshot.supports_logo
        && !brand_supports_logo
    {
        show_logo = false;
    }
    info!(
        printer_name = %printer_name,
        detected_brand = %detected_brand.label(),
        verification_status = %verification_status,
        app_language = %app_language,
        "Auto-detection: brand and language"
    );

    // Profile character set (manual override)
    let profile_character_set = profile
        .get("characterSet")
        .or_else(|| profile.get("character_set"))
        .and_then(Value::as_str)
        .unwrap_or("PC437_USA");

    // Auto-upgrade: if profile uses the default PC437_USA and app language is not English,
    // use the language-appropriate character set instead.
    let character_set =
        if profile_character_set == "PC437_USA" && !app_language.is_empty() && app_language != "en"
        {
            let auto_cs = receipt_renderer::language_to_character_set(&app_language);
            info!(
                language = %app_language,
                auto_character_set = %auto_cs,
                "Auto-detected character set from app language"
            );
            auto_cs.to_string()
        } else {
            profile_character_set.to_string()
        };

    let greek_render_mode = profile
        .get("greekRenderMode")
        .or_else(|| profile.get("greek_render_mode"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    // Manual code page override takes priority
    let manual_code_page = profile
        .get("escposCodePage")
        .or_else(|| profile.get("escpos_code_page"))
        .and_then(Value::as_u64)
        .map(|v| v as u8);
    let code_page_brand =
        receipt_renderer::effective_code_page_brand(detected_brand, emulation_mode);

    let escpos_code_page = if manual_code_page.is_some() {
        info!(
            manual_code_page = ?manual_code_page,
            "Using manual code page override"
        );
        manual_code_page
    } else {
        let auto_cp = receipt_renderer::resolve_auto_code_page(code_page_brand, &character_set);
        if auto_cp.is_some() {
            info!(
                detected_brand = %detected_brand.label(),
                code_page_brand = %code_page_brand.label(),
                character_set = %character_set,
                auto_code_page = ?auto_cp,
                "Auto-resolved code page for brand"
            );
        }
        auto_cp
    };

    let currency_symbol = if template == ReceiptTemplate::Classic
        && matches!(entity_type, "order_receipt" | "delivery_slip")
    {
        receipt_renderer::normalize_currency_symbol_for_layout(
            &currency_symbol,
            &character_set,
            escpos_code_page,
            detected_brand,
        )
    } else {
        currency_symbol
    };

    let text_scale = setting_text(&conn, "receipt", "text_scale")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(1.25)
        .clamp(0.8, 2.0);
    let logo_scale = setting_text(&conn, "receipt", "logo_scale")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(1.0)
        .clamp(0.5, 2.0);
    let layout_density_scale = setting_text(&conn, "receipt", "layout_density_scale")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(1.0)
        .clamp(0.7, 1.35);
    let body_font_weight: u32 = match setting_text(&conn, "receipt", "body_boldness").as_deref() {
        Some("2") => 500,
        Some("3") => 600,
        Some("4") => 700,
        Some("5") => 800,
        _ => 400,
    };

    Ok(LayoutConfig {
        paper_width: crate::escpos::PaperWidth::from_mm(paper_mm),
        template,
        command_profile,
        organization_name,
        store_address,
        store_phone,
        vat_number,
        tax_office,
        footer_text,
        show_qr_code,
        qr_data,
        show_logo,
        logo_url,
        copy_label,
        character_set,
        greek_render_mode,
        escpos_code_page,
        detected_brand,
        language: app_language.clone(),
        store_subtitle,
        currency_symbol,
        font_type,
        layout_density,
        header_emphasis,
        layout_density_scale,
        decimal_comma: matches!(
            app_language.as_str(),
            "el" | "de" | "fr" | "it" | "es" | "pt" | "nl"
        ),
        classic_customer_render_mode,
        emulation_mode,
        printable_width_dots,
        left_margin_dots,
        raster_threshold,
        text_scale,
        logo_scale,
        body_font_weight,
    })
}

fn paper_logo_max_width_dots(paper: crate::escpos::PaperWidth) -> u32 {
    match paper {
        crate::escpos::PaperWidth::Mm58 => 384,
        crate::escpos::PaperWidth::Mm80 => 576,
        crate::escpos::PaperWidth::Mm112 => 832,
    }
}

fn paper_logo_max_height_dots(paper: crate::escpos::PaperWidth) -> u32 {
    match paper {
        crate::escpos::PaperWidth::Mm58 => 160,
        crate::escpos::PaperWidth::Mm80 => 220,
        crate::escpos::PaperWidth::Mm112 => 280,
    }
}

fn paper_logo_max_height_dots_for_brand(
    paper: crate::escpos::PaperWidth,
    brand: crate::printers::PrinterBrand,
) -> u32 {
    if brand == crate::printers::PrinterBrand::Star {
        match paper {
            crate::escpos::PaperWidth::Mm58 => 384,
            crate::escpos::PaperWidth::Mm80 => 480,
            crate::escpos::PaperWidth::Mm112 => 640,
        }
    } else {
        paper_logo_max_height_dots(paper)
    }
}

fn parse_data_url_image(source: &str) -> Option<Vec<u8>> {
    let trimmed = source.trim();
    if !trimmed.starts_with("data:image/") {
        return None;
    }
    let (_, payload) = trimmed.split_once(',')?;
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()
}

fn read_logo_source_bytes(source: &str) -> Result<Vec<u8>, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Logo source is empty".to_string());
    }

    if let Some(bytes) = parse_data_url_image(trimmed) {
        return Ok(bytes);
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        // Check for cached logo (avoids repeated HTTP fetches)
        let cache_path = std::env::temp_dir().join("thesmall_logo_cache.bin");
        let cache_url_path = std::env::temp_dir().join("thesmall_logo_cache_url.txt");
        if cache_path.exists() {
            if let Ok(cached_url) = fs::read_to_string(&cache_url_path) {
                if cached_url.trim() == trimmed {
                    if let Ok(metadata) = fs::metadata(&cache_path) {
                        if let Ok(modified) = metadata.modified() {
                            if modified.elapsed().unwrap_or(Duration::from_secs(86401))
                                < Duration::from_secs(86400)
                            {
                                return fs::read(&cache_path)
                                    .map_err(|e| format!("logo cache read: {e}"));
                            }
                        }
                    }
                }
            }
        }

        // Must run on a dedicated OS thread — reqwest::blocking panics
        // if called from within a Tokio async runtime.
        let url = trimmed.to_string();
        let handle = std::thread::spawn(move || -> Result<Vec<u8>, String> {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(8))
                .build()
                .map_err(|e| format!("logo HTTP client: {e}"))?;
            let response = client
                .get(&url)
                .send()
                .map_err(|e| format!("logo fetch failed: {e}"))?;
            if !response.status().is_success() {
                return Err(format!("logo fetch failed with HTTP {}", response.status()));
            }
            // Reject non-image responses (e.g. HTML error pages from CDN)
            if let Some(ct) = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
            {
                if !ct.starts_with("image/") {
                    return Err(format!(
                        "logo URL returned content-type '{ct}', expected image/*"
                    ));
                }
            }
            response
                .bytes()
                .map(|b| b.to_vec())
                .map_err(|e| format!("logo fetch bytes failed: {e}"))
        });
        let bytes = handle
            .join()
            .map_err(|_| "logo fetch thread panicked".to_string())??;

        // Cache the fetched logo for subsequent prints
        let _ = fs::write(&cache_path, &bytes);
        let _ = fs::write(&cache_url_path, trimmed);

        return Ok(bytes);
    }

    let path_value = if trimmed.starts_with("file://") {
        let raw = trimmed.trim_start_matches("file://");
        if cfg!(windows) && raw.starts_with('/') {
            let bytes = raw.as_bytes();
            if bytes.len() >= 3 && bytes[2] == b':' {
                raw[1..].to_string()
            } else {
                raw.to_string()
            }
        } else {
            raw.to_string()
        }
    } else {
        trimmed.to_string()
    };

    fs::read(&path_value).map_err(|e| format!("logo file read failed ({path_value}): {e}"))
}

fn decode_logo_to_grayscale(image_bytes: &[u8]) -> Result<image::GrayImage, String> {
    if image_bytes.len() > 4 {
        let head = &image_bytes[..4];
        if head.starts_with(b"<!DO")
            || head.starts_with(b"<htm")
            || head.starts_with(b"<HTM")
            || head.starts_with(b"<?xm")
        {
            return Err("Logo URL returned HTML/XML instead of an image".to_string());
        }
    }

    let decoded = image::load_from_memory(image_bytes).map_err(|e| format!("logo decode: {e}"))?;
    let rgba = decoded.to_rgba8();
    let (src_w, src_h) = rgba.dimensions();
    if src_w == 0 || src_h == 0 {
        return Err("logo image has invalid dimensions".to_string());
    }

    let mut white_bg =
        image::RgbaImage::from_pixel(src_w, src_h, image::Rgba([255, 255, 255, 255]));
    image::imageops::overlay(&mut white_bg, &rgba, 0, 0);
    Ok(image::DynamicImage::ImageRgba8(white_bg).to_luma8())
}

fn receipt_like_logo_max_width_dots(paper: crate::escpos::PaperWidth) -> u32 {
    match paper {
        crate::escpos::PaperWidth::Mm58 => 176,
        crate::escpos::PaperWidth::Mm80 => 260,
        crate::escpos::PaperWidth::Mm112 => 360,
    }
}

fn receipt_like_logo_max_height_dots(paper: crate::escpos::PaperWidth) -> u32 {
    match paper {
        crate::escpos::PaperWidth::Mm58 => 110,
        crate::escpos::PaperWidth::Mm80 => 160,
        crate::escpos::PaperWidth::Mm112 => 210,
    }
}

pub(crate) fn load_receipt_like_logo_image(
    cfg: &LayoutConfig,
) -> Result<Option<image::GrayImage>, String> {
    if !cfg.show_logo {
        return Ok(None);
    }

    let Some(source) = cfg
        .logo_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    // Check in-memory GrayImage cache to skip expensive decode + resize.
    let cache_key = format!(
        "img|{}|{:?}|{}|{:.2}",
        source, cfg.paper_width, cfg.printable_width_dots, cfg.logo_scale
    );
    if let Ok(cache) = logo_image_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            info!(
                cache_key = %cache_key,
                w = cached.width(),
                h = cached.height(),
                "Receipt-like logo image cache hit"
            );
            return Ok(Some(cached.clone()));
        }
    }

    let image_bytes = read_logo_source_bytes(source)?;
    let gray = decode_logo_to_grayscale(&image_bytes)?;
    let (src_w, src_h) = gray.dimensions();

    let content_cap = u32::from(cfg.printable_width_dots)
        .saturating_sub(32)
        .max(64);
    let max_width = ((receipt_like_logo_max_width_dots(cfg.paper_width) as f32 * cfg.logo_scale)
        as u32)
        .min(content_cap);
    let max_height =
        (receipt_like_logo_max_height_dots(cfg.paper_width) as f32 * cfg.logo_scale) as u32;

    let mut target_w = src_w.min(max_width).max(1);
    let mut target_h = ((src_h as f32 * (target_w as f32 / src_w as f32)).round() as u32).max(1);
    if target_h > max_height {
        target_h = max_height;
        target_w = ((src_w as f32 * (target_h as f32 / src_h as f32)).round() as u32).max(1);
    }

    let resized = if target_w != src_w || target_h != src_h {
        image::DynamicImage::ImageLuma8(gray)
            .thumbnail(target_w, target_h)
            .to_luma8()
    } else {
        gray
    };

    // Store in GrayImage cache for subsequent prints.
    if let Ok(mut cache) = logo_image_cache().lock() {
        cache.insert(cache_key, resized.clone());
    }

    Ok(Some(resized))
}

fn rasterize_logo_to_escpos_prefix(
    image_bytes: &[u8],
    paper: crate::escpos::PaperWidth,
) -> Result<Vec<u8>, String> {
    // Validate that the bytes look like an image, not HTML or other text
    if image_bytes.len() > 4 {
        let head = &image_bytes[..4];
        if head.starts_with(b"<!DO")
            || head.starts_with(b"<htm")
            || head.starts_with(b"<HTM")
            || head.starts_with(b"<?xm")
        {
            return Err("Logo URL returned HTML/XML instead of an image".to_string());
        }
    }

    let gray = decode_logo_to_grayscale(image_bytes)?;
    let (src_w, src_h) = gray.dimensions();

    let max_width = paper_logo_max_width_dots(paper).max(8);
    let mut target_w = src_w.min(max_width);
    if target_w == 0 {
        target_w = 1;
    }
    let mut target_h = ((src_h as f32 * (target_w as f32 / src_w as f32)).round() as u32).max(1);
    // Keep logos compact on thermal paper.
    let max_h = paper_logo_max_height_dots(paper);
    if target_h > max_h {
        target_h = max_h;
        target_w = ((src_w as f32 * (target_h as f32 / src_h as f32)).round() as u32).max(1);
    }

    info!(
        src_w = src_w,
        src_h = src_h,
        target_w = target_w,
        target_h = target_h,
        paper = ?paper,
        "Rasterizing logo for ESC/POS"
    );

    let resized = if target_w != src_w || target_h != src_h {
        image::DynamicImage::ImageLuma8(gray)
            .thumbnail(target_w, target_h)
            .to_luma8()
    } else {
        gray
    };

    let width = resized.width();
    let height = resized.height();

    // Use ESC * column-format bit image (m=33, 24-dot double-density) for
    // maximum printer compatibility.  GS v 0 raster images are not reliably
    // supported by all Star, Citizen, and older Epson firmware.
    //
    // ESC * sends the image in horizontal strips of 24 rows each.  Each strip
    // is a single ESC * command:  ESC * 33 nL nH [column data…]
    // For each column, 3 bytes encode 24 vertical pixels (MSB at top).
    let strips = height.div_ceil(24);
    let mut builder = crate::escpos::EscPosBuilder::new();
    builder.center();
    for strip in 0..strips {
        let y_start = strip * 24;
        // ESC * m nL nH — select bit-image mode
        //   m = 33 (24-dot double-density)
        //   nL/nH = number of columns (little-endian)
        let n_l = (width & 0xFF) as u8;
        let n_h = ((width >> 8) & 0xFF) as u8;
        builder.raw(&[0x1B, b'*', 33, n_l, n_h]);
        for x in 0..width {
            let mut col = [0u8; 3];
            for dy in 0..24u32 {
                let y = y_start + dy;
                if y >= height {
                    break;
                }
                let luma = resized.get_pixel(x, y).0[0];
                if luma < 160 {
                    col[(dy / 8) as usize] |= 0x80 >> (dy % 8);
                }
            }
            builder.raw(&col);
        }
        builder.lf();
    }
    builder.left();

    let result = builder.build();
    info!(
        strips = strips,
        total_bytes = result.len(),
        "Logo ESC/POS prefix generated"
    );
    Ok(result)
}

/// Rasterize a logo image to raster format — Star raster (`ESC * r`) for Star
/// printers, GS v 0 for everything else.  Unlike the column-format ESC * 33
/// used by `rasterize_logo_to_escpos_prefix`, raster mode sends a single block
/// of image data which Star mC-Print3 (and similar) handles correctly.
fn rasterize_logo_to_escpos_raster(
    image_bytes: &[u8],
    paper: crate::escpos::PaperWidth,
    brand: crate::printers::PrinterBrand,
) -> Result<Vec<u8>, String> {
    if image_bytes.len() > 4 {
        let head = &image_bytes[..4];
        if head.starts_with(b"<!DO")
            || head.starts_with(b"<htm")
            || head.starts_with(b"<HTM")
            || head.starts_with(b"<?xm")
        {
            return Err("Logo URL returned HTML/XML instead of an image".to_string());
        }
    }

    let gray = decode_logo_to_grayscale(image_bytes)?;
    let (src_w, src_h) = gray.dimensions();
    if src_w > 1200 || src_h > 1200 {
        warn!(
            src_w, src_h,
            "Logo source image is very large — consider resizing to \u{2264}600\u{00D7}600 for faster first-print"
        );
    }

    let max_width = paper_logo_max_width_dots(paper).max(8);
    let use_star_raster = brand == crate::printers::PrinterBrand::Star;

    // Scale to a reasonable size: max paper width and a compact height cap per paper size.
    let mut target_w = src_w.min(max_width);
    if target_w == 0 {
        target_w = 1;
    }
    let mut target_h = ((src_h as f32 * (target_w as f32 / src_w as f32)).round() as u32).max(1);
    let max_h = paper_logo_max_height_dots_for_brand(paper, brand);
    if target_h > max_h {
        target_h = max_h;
        target_w = ((src_w as f32 * (target_h as f32 / src_h as f32)).round() as u32).max(1);
    }

    // For Star raster: use full paper width and center the image data in each row.
    // Star raster mode ignores ESC alignment commands.
    let paper_width_bytes = (max_width.div_ceil(8)) as u16;
    let image_width_bytes = target_w.div_ceil(8) as u16;
    let left_pad_bytes = if use_star_raster {
        paper_width_bytes.saturating_sub(image_width_bytes) / 2
    } else {
        0
    };
    // Star raster protocol requires each row to be exactly the full paper
    // width.  Using a partial width causes the printer to misalign subsequent
    // rows, producing garbled output and meters of wasted paper.
    let width_bytes = if use_star_raster {
        paper_width_bytes
    } else {
        image_width_bytes
    };
    let raster_w = width_bytes as u32 * 8;

    info!(
        src_w, src_h, target_w, target_h, raster_w,
        star_mode = use_star_raster,
        paper = ?paper,
        "Rasterizing logo for raster format"
    );

    let resized = if target_w != src_w || target_h != src_h {
        // Use thumbnail() for large downscale ratios (e.g. 5905→400) — it picks
        // the fastest filter automatically and is orders of magnitude quicker
        // than resize() with Triangle for big images.
        image::DynamicImage::ImageLuma8(gray)
            .thumbnail(target_w, target_h)
            .to_luma8()
    } else {
        gray
    };

    let width = resized.width();
    let height = resized.height();

    // Build raster data: each row is width_bytes bytes, MSB first
    let mut raster_data = Vec::with_capacity((width_bytes as u32 * height) as usize);
    for y in 0..height {
        for bx in 0..width_bytes {
            // Check if this byte falls within the centered image area
            let img_bx = bx as i32 - left_pad_bytes as i32;
            if img_bx < 0 || (img_bx as u32) * 8 >= target_w.div_ceil(8) * 8 {
                raster_data.push(0u8); // padding byte
                continue;
            }
            let mut byte_val = 0u8;
            for bit in 0..8u32 {
                let x = img_bx as u32 * 8 + bit;
                if x < width {
                    let luma = resized.get_pixel(x, y).0[0];
                    if luma < 160 {
                        byte_val |= 0x80 >> bit;
                    }
                }
            }
            raster_data.push(byte_val);
        }
    }

    // Trim leading blank rows (white space at top of image)
    let wb = width_bytes as usize;
    let mut leading_blank = 0usize;
    for row in 0..height as usize {
        let row_start = row * wb;
        let row_end = row_start + wb;
        if raster_data[row_start..row_end].iter().all(|&b| b == 0) {
            leading_blank += 1;
        } else {
            break;
        }
    }

    // Trim trailing blank rows (white space at bottom of image)
    let mut effective_height = height as usize;
    while effective_height > leading_blank {
        let row_start = (effective_height - 1) * wb;
        let row_end = row_start + wb;
        if raster_data[row_start..row_end].iter().all(|&b| b == 0) {
            effective_height -= 1;
        } else {
            break;
        }
    }

    // Apply trimming: remove leading and trailing blank rows
    if leading_blank > 0 || effective_height < height as usize {
        let trimmed_data = raster_data[leading_blank * wb..effective_height * wb].to_vec();
        raster_data = trimmed_data;
        let trimmed_height = effective_height - leading_blank;
        info!(
            original_height = height,
            leading_blank,
            trailing_blank = height as usize - effective_height,
            trimmed_height,
            "Trimmed blank rows from logo raster"
        );
        effective_height = trimmed_height;
    } else {
        effective_height = height as usize;
    }

    let mut builder = crate::escpos::EscPosBuilder::new();
    if !use_star_raster {
        builder.center();
    }
    if use_star_raster {
        builder.star_raster_image(width_bytes, effective_height as u16, &raster_data);
    } else {
        builder.raster_image(width_bytes, effective_height as u16, &raster_data);
    }
    if !use_star_raster {
        builder.left();
    }

    let result = builder.build();
    let format_label = if use_star_raster {
        "Star Line Mode raster"
    } else {
        "GS v 0 raster"
    };
    info!(
        raster_data_bytes = raster_data.len(),
        total_bytes = result.len(),
        width_bytes,
        effective_height,
        format = format_label,
        "Logo raster prefix generated"
    );

    // Safety guard: reject absurdly large raster data that would produce
    // meters of paper output.  60 KB is generous for a logo on 80 mm paper.
    const MAX_LOGO_RASTER_BYTES: usize = 60_000;
    if result.len() > MAX_LOGO_RASTER_BYTES {
        warn!(
            bytes = result.len(),
            max = MAX_LOGO_RASTER_BYTES,
            "Logo raster exceeds safety limit — skipping logo to prevent runaway output"
        );
        return Err(format!(
            "Logo raster too large ({} bytes, max {})",
            result.len(),
            MAX_LOGO_RASTER_BYTES
        ));
    }

    Ok(result)
}

/// In-memory cache for rasterized logo ESC/POS bytes.
///
/// Keyed on `"{logo_url}|{paper_width:?}|{brand:?}"`.  Decoding + compositing
/// + resizing a 5905×5905 source image takes ~8 s; caching makes subsequent
///   prints near-instant.
fn logo_cache() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// In-memory cache for decoded + resized logo GrayImages (used by raster-exact path).
/// Avoids the expensive image decode + resize (~2-5 s for large logos) on every print.
fn logo_image_cache() -> &'static Mutex<HashMap<String, image::GrayImage>> {
    static CACHE: OnceLock<Mutex<HashMap<String, image::GrayImage>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Clear the logo raster cache (e.g. after printer profile or logo URL change).
#[allow(dead_code)]
pub fn clear_logo_cache() {
    if let Ok(mut cache) = logo_cache().lock() {
        cache.clear();
    }
    if let Ok(mut cache) = logo_image_cache().lock() {
        cache.clear();
    }
    // Also remove disk-cached raster files.
    if let Ok(entries) = fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("thesmall_logo_raster_") && name.ends_with(".bin") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
    info!("Logo raster cache cleared (memory + disk)");
}

/// Return a stable path for the on-disk raster cache file.
/// The filename is a simple hash of the cache key so different logo URLs /
/// paper widths / brands get separate files.
fn raster_cache_path(cache_key: &str) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    cache_key.hash(&mut h);
    std::env::temp_dir().join(format!("thesmall_logo_raster_{:016x}.bin", h.finish()))
}

pub(crate) fn build_logo_prefix_for_layout(
    layout: &LayoutConfig,
) -> Result<Option<Vec<u8>>, String> {
    if !layout.show_logo {
        return Ok(None);
    }
    let Some(source) = layout
        .logo_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    info!(
        brand = ?layout.detected_brand,
        paper = ?layout.paper_width,
        "Building logo prefix"
    );

    // Check cache first — avoids re-decoding + rasterizing the same logo.
    let cache_key = format!(
        "v9|{}|{:?}|{:?}|{:.2}",
        source, layout.paper_width, layout.detected_brand, layout.logo_scale
    );
    if let Ok(cache) = logo_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            info!(
                cache_key = %cache_key,
                bytes = cached.len(),
                "Logo raster cache hit (memory)"
            );
            return Ok(Some(cached.clone()));
        }
    }

    // Check persistent disk cache — survives app restarts, avoids the
    // expensive image-decode + rasterize step (~5 s for very large logos).
    let disk_path = raster_cache_path(&cache_key);
    if disk_path.exists() {
        if let Ok(metadata) = fs::metadata(&disk_path) {
            // Disk cache valid for 7 days.
            if metadata
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age < Duration::from_secs(7 * 86400))
            {
                if let Ok(cached) = fs::read(&disk_path) {
                    if !cached.is_empty() {
                        info!(bytes = cached.len(), "Logo raster cache hit (disk)");
                        // Populate in-memory cache too.
                        if let Ok(mut mem) = logo_cache().lock() {
                            mem.insert(cache_key.clone(), cached.clone());
                        }
                        return Ok(Some(cached));
                    }
                }
            }
        }
    }

    let bytes = read_logo_source_bytes(source)?;

    // Star printers can't handle ESC * 33 column bit-image.  Use the
    // Star-specific ESC * r raster protocol instead (Star Line Mode).
    // GS v 0 is NOT supported by Star mC-Print3 and similar models.
    let prefix = if layout.detected_brand == crate::printers::PrinterBrand::Star {
        info!("Using Star raster (ESC * r) for Star printer logo");
        rasterize_logo_to_escpos_raster(
            &bytes,
            layout.paper_width,
            crate::printers::PrinterBrand::Star,
        )?
    } else {
        rasterize_logo_to_escpos_prefix(&bytes, layout.paper_width)?
    };

    // Store in memory cache for subsequent prints within this session.
    if let Ok(mut cache) = logo_cache().lock() {
        cache.insert(cache_key, prefix.clone());
    }

    // Persist to disk so next app start skips the decode+rasterize step.
    if let Err(e) = fs::write(&disk_path, &prefix) {
        warn!(error = %e, "Failed to write logo raster disk cache");
    } else {
        info!(bytes = prefix.len(), "Logo raster saved to disk cache");
    }

    Ok(Some(prefix))
}

fn resolve_driver_name_from_shifts(conn: &rusqlite::Connection, staff_id: &str) -> Option<String> {
    let staff_id = staff_id.trim();
    if staff_id.is_empty() {
        return None;
    }

    conn.query_row(
        "SELECT staff_name
         FROM staff_shifts
         WHERE staff_id = ?1
           AND TRIM(COALESCE(staff_name, '')) <> ''
         ORDER BY COALESCE(check_in_time, created_at, updated_at) DESC, updated_at DESC
         LIMIT 1",
        params![staff_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .map(|name| name.trim().to_string())
    .filter(|name| !name.is_empty())
}

fn non_empty_field(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn kiosk_context_label_from_metadata(raw: &str) -> Option<String> {
    let metadata = serde_json::from_str::<Value>(raw).ok()?;
    let kiosk = metadata.get("kiosk")?;
    let label = kiosk.get("contextLabel").and_then(Value::as_str)?;
    non_empty_text(label)
}

fn kiosk_context_note_from_metadata(raw: &str) -> Option<String> {
    kiosk_context_label_from_metadata(raw).map(|label| format!("Kiosk context: {label}"))
}

pub fn build_order_receipt_doc(db: &DbState, order_id: &str) -> Result<OrderReceiptDoc, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    // W6: `orders.payment_method` was dropped in v55. Derive the method
    // from completed `order_payments` rows via the canonical helper. For
    // orders with no completed payment rows, `derive_payment_method`
    // returns None → empty string → the snapshot fallback at the end of
    // this function emits no payment line (the receipt still renders
    // the total just without a "Cash"/"Card" label). This matches the
    // fundamental limit of the new model: if nothing persisted a method,
    // the terminal genuinely doesn't know it.
    let derived_payment_method =
        crate::payments::derive_payment_method(&conn, order_id)?.unwrap_or_default();
    let order = conn
        .query_row(
            "SELECT COALESCE(NULLIF(display_order_number, ''), order_number, ''), COALESCE(order_type, ''), COALESCE(status, ''),
                    COALESCE(created_at, ''), COALESCE(table_number, ''), COALESCE(customer_name, ''),
                    COALESCE(customer_phone, ''), COALESCE(items, '[]'), COALESCE(total_amount, 0),
                    COALESCE(subtotal, 0), COALESCE(tax_amount, 0), COALESCE(discount_amount, 0),
                    COALESCE(discount_percentage, 0), COALESCE(delivery_fee, 0), COALESCE(tip_amount, 0), COALESCE(delivery_address, ''),
                    COALESCE(delivery_city, ''), COALESCE(delivery_postal_code, ''),
                    COALESCE(delivery_floor, ''), COALESCE(name_on_ringer, ''),
                    COALESCE(driver_id, ''), COALESCE(driver_name, ''), COALESCE(staff_id, ''),
                    COALESCE(delivery_notes, ''), COALESCE(special_instructions, ''),
                    COALESCE(payment_status, ''),
                    COALESCE(payment_transaction_id, ''),
                    COALESCE(ghost_metadata, ''),
                    COALESCE(plugin, ''),
                    COALESCE(is_test, 0),
                    COALESCE(external_plugin_order_id, ''),
                    COALESCE(CAST(estimated_time AS TEXT), '')
             FROM orders WHERE id = ?1",
            params![order_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, f64>(8)?,
                    row.get::<_, f64>(9)?,
                    row.get::<_, f64>(10)?,
                    row.get::<_, f64>(11)?,
                    row.get::<_, f64>(12)?,
                    row.get::<_, f64>(13)?,
                    row.get::<_, f64>(14)?,
                    row.get::<_, String>(15)?,
                    row.get::<_, String>(16)?,
                    row.get::<_, String>(17)?,
                    row.get::<_, String>(18)?,
                    row.get::<_, String>(19)?,
                    row.get::<_, String>(20)?,
                    row.get::<_, String>(21)?,
                    row.get::<_, String>(22)?,
                    row.get::<_, String>(23)?,
                    row.get::<_, String>(24)?,
                    row.get::<_, String>(25)?,
                    row.get::<_, String>(26)?,
                    row.get::<_, String>(27)?,
                    row.get::<_, String>(28)?,
                    row.get::<_, i64>(29)?,
                    row.get::<_, String>(30)?,
                    row.get::<_, String>(31)?,
                ))
            },
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => format!("Order not found: {order_id}"),
            other => format!("Load order {order_id} for receipt: {other}"),
        })?;
    let (
        order_number,
        order_type,
        status,
        created_at,
        table_number,
        customer_name,
        customer_phone,
        items_json,
        total_amount,
        subtotal,
        tax_amount,
        discount_amount,
        discount_percentage,
        delivery_fee,
        tip_amount,
        delivery_address,
        delivery_city,
        delivery_postal_code,
        delivery_floor,
        name_on_ringer,
        driver_id,
        driver_name,
        staff_id,
        delivery_notes,
        special_instructions,
        payment_status,
        payment_transaction_id,
        ghost_metadata,
        plugin,
        is_test,
        external_order_id,
        estimated_time_raw,
    ) = order;
    let payment_method = derived_payment_method;
    let menu_lookup = build_menu_category_lookup(&conn);

    let items: Vec<ReceiptItem> = serde_json::from_str::<Value>(&items_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            let category_fields = resolve_item_category_fields(&item, &menu_lookup);
            ReceiptItem {
                name: item
                    .get("name")
                    .or_else(|| item.get("itemName"))
                    .or_else(|| item.get("menu_item_name"))
                    .or_else(|| item.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("Item")
                    .to_string(),
                quantity: item.get("quantity").and_then(parse_number).unwrap_or(1.0),
                total: parse_item_total(&item),
                category_name: category_fields.category_name,
                subcategory_name: category_fields.subcategory_name,
                category_path: category_fields.category_path,
                note: build_item_note_text(&item),
                customizations: parse_item_customizations(&item),
            }
        })
        .collect();

    let mut order_notes: Vec<String> = Vec::new();
    let kiosk_context_note = kiosk_context_note_from_metadata(&ghost_metadata);
    push_unique_trimmed_note(&mut order_notes, kiosk_context_note.as_deref());
    push_unique_trimmed_note(&mut order_notes, Some(&delivery_notes));
    let special_instructions =
        strip_platform_items_fallback(&special_instructions, !items.is_empty());
    push_unique_trimmed_note(&mut order_notes, Some(&special_instructions));

    // THE-434 faithful slip: platform orders headline the rider's short code
    // (efood's own receipt prints «#4545» as the biggest element), so the big
    // reverse banner shows the 4-digit code and the long platform order id
    // moves to its own footer line — mirroring efood's «ΚΩΔΙΚΟΣ ΠΑΡΑΓΓΕΛΙΑΣ».
    let platform_short_code = if is_food_delivery_plugin(&plugin) {
        food_delivery_short_code(&ghost_metadata)
    } else {
        None
    };
    if platform_short_code.is_some() {
        let external_order_id = external_order_id.trim();
        if !external_order_id.is_empty() {
            order_notes.push(format!("ΚΩΔΙΚΟΣ ΠΑΡΑΓΓΕΛΙΑΣ: {external_order_id}"));
        }
    }

    let effective_discount = discount_amount.max(0.0);
    let computed_subtotal =
        total_amount - tax_amount - delivery_fee - tip_amount + effective_discount;
    let display_subtotal = if computed_subtotal.is_finite() && computed_subtotal > 0.0 {
        computed_subtotal
    } else {
        subtotal.max(0.0)
    };

    let mut totals = Vec::new();
    totals.push(TotalsLine {
        label: "Subtotal".to_string(),
        amount: display_subtotal,
        emphasize: false,
        discount_percent: None,
    });
    if discount_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Discount".to_string(),
            amount: -discount_amount,
            emphasize: false,
            discount_percent: if discount_percentage > 0.0 {
                Some(discount_percentage)
            } else {
                None
            },
        });
    }
    if tax_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Tax".to_string(),
            amount: tax_amount,
            emphasize: false,
            discount_percent: None,
        });
    }
    if delivery_fee > 0.0 {
        totals.push(TotalsLine {
            label: "Delivery".to_string(),
            amount: delivery_fee,
            emphasize: false,
            discount_percent: None,
        });
    }
    if tip_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Tip".to_string(),
            amount: tip_amount,
            emphasize: false,
            discount_percent: None,
        });
    }
    totals.push(TotalsLine {
        label: "TOTAL".to_string(),
        amount: total_amount,
        emphasize: true,
        discount_percent: None,
    });

    let mut payments_stmt = conn
        .prepare(
            "SELECT COALESCE(method, ''), COALESCE(amount, 0), cash_received, change_given, COALESCE(transaction_ref, '')
             FROM order_payments
             WHERE order_id = ?1 AND status = 'completed'
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare payments: {e}"))?;

    type PaymentRow = (String, f64, Option<f64>, Option<f64>, String);
    let payment_rows: Vec<PaymentRow> = payments_stmt
        .query_map(params![order_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| format!("query payments: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut payments = Vec::new();
    let mut masked_card = None;
    for (method, amount, cash_received, change_given, transaction_ref) in payment_rows {
        let label = match method.as_str() {
            "cash" => "Cash",
            "card" => "Card",
            _ => "Other",
        };
        let normalized_amount = if method == "cash" {
            cash_received
                .filter(|received| *received > 0.0)
                .unwrap_or(amount)
        } else {
            amount
        };
        payments.push(PaymentLine {
            label: label.to_string(),
            amount: normalized_amount,
            detail: None,
        });
        if let Some(change) = change_given {
            if change > 0.0 {
                payments.push(PaymentLine {
                    label: "Change".to_string(),
                    amount: change,
                    detail: None,
                });
            }
        }
        if masked_card.is_none() && method == "card" {
            masked_card = extract_masked_card_reference(&transaction_ref);
        }
    }
    if payments.is_empty() {
        if let Some(payment) = fallback_payment_line_from_order_snapshot(
            &payment_method,
            &payment_status,
            total_amount,
        ) {
            payments.push(payment);
        }
    }
    if masked_card.is_none() {
        masked_card = extract_masked_card_reference(&payment_transaction_id);
    }

    let mut adjustments_stmt = conn
        .prepare(
            "SELECT COALESCE(adjustment_type, ''), COALESCE(amount, 0), COALESCE(reason, '')
             FROM payment_adjustments WHERE order_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare adjustments: {e}"))?;
    let adjustments: Vec<AdjustmentLine> = adjustments_stmt
        .query_map(params![order_id], |row| {
            let kind: String = row.get(0)?;
            let label = match kind.as_str() {
                "void" => "Void",
                "refund" => "Refund",
                _ => "Adjustment",
            };
            Ok(AdjustmentLine {
                label: label.to_string(),
                amount: row.get::<_, f64>(1)?,
                reason: row
                    .get::<_, String>(2)
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
            })
        })
        .map_err(|e| format!("query adjustments: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let resolved_driver_name = non_empty_field(driver_name)
        .or_else(|| resolve_driver_name_from_shifts(&conn, &driver_id))
        .or_else(|| resolve_driver_name_from_shifts(&conn, &staff_id));

    Ok(OrderReceiptDoc {
        order_id: order_id.to_string(),
        order_number: platform_short_code.unwrap_or(if order_number.is_empty() {
            order_id.to_string()
        } else {
            order_number
        }),
        order_type,
        status,
        created_at: created_at.clone(),
        table_number: non_empty_field(table_number),
        customer_name: non_empty_field(customer_name),
        customer_phone: non_empty_field(customer_phone),
        delivery_address: non_empty_field(delivery_address),
        delivery_city: non_empty_field(delivery_city),
        delivery_postal_code: non_empty_field(delivery_postal_code),
        delivery_floor: non_empty_field(delivery_floor),
        name_on_ringer: non_empty_field(name_on_ringer),
        driver_id: non_empty_field(driver_id),
        driver_name: resolved_driver_name,
        delivery_slip_mode: DeliverySlipMode::DeliveryOrder,
        items,
        totals,
        payments,
        adjustments,
        masked_card,
        order_notes,
        // Platform orders print who they belong to, the rider's short code,
        // and the handoff payment line; the completed/canceled variants
        // overwrite this with their own label downstream.
        status_label: {
            let banner =
                platform_slip_banner(&plugin, &ghost_metadata, &payment_status, total_amount);
            if is_test != 0 {
                // Sandbox slips only print behind the print_sandbox_orders
                // override — when they do, the paper must say so loudly.
                Some(match banner {
                    Some(banner) => format!("ΔΟΚΙΜΗ TEST · {banner}"),
                    None => "ΔΟΚΙΜΗ TEST".to_string(),
                })
            } else {
                banner
            }
        },
        cancellation_reason: None,
        // THE-434 v2: food-delivery orders switch the renderer to the faithful
        // platform slip (modeled on the real efood slip #4579, 27/08/2026).
        platform_slip: if crate::print::is_food_delivery_plugin(&plugin) {
            let food_delivery = serde_json::from_str::<serde_json::Value>(&ghost_metadata)
                .ok()
                .and_then(|metadata| metadata.get("food_delivery").cloned())
                .unwrap_or(serde_json::Value::Null);
            let field = |key: &str| {
                food_delivery
                    .get(key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            };
            Some(receipt_renderer::PlatformSlipInfo {
                plugin: plugin.trim().to_ascii_lowercase(),
                external_order_id: Some(external_order_id.trim().to_string())
                    .filter(|value| !value.is_empty()),
                short_code: field("short_code"),
                payment_method: field("payment_method"),
                prepaid: food_delivery
                    .get("prepaid")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                delivery_provider: field("delivery_provider"),
                is_test: is_test != 0,
                // The slip headlines the PROMISED time: accept moment + the
                // prep minutes the store gave. estimated_time is minutes when
                // numeric; a full timestamp passes through as-is.
                ready_at: {
                    let trimmed = estimated_time_raw.trim();
                    if let Ok(minutes) = trimmed.parse::<i64>() {
                        // created_at is RFC3339 for app-created and materialized
                        // rows, but SQLite's own "YYYY-MM-DD HH:MM:SS" (UTC)
                        // appears on legacy/default-stamped rows — accept both.
                        chrono::DateTime::parse_from_rfc3339(created_at.trim())
                            .map(|start| start.with_timezone(&chrono::Utc))
                            .ok()
                            .or_else(|| {
                                chrono::NaiveDateTime::parse_from_str(
                                    created_at.trim(),
                                    "%Y-%m-%d %H:%M:%S",
                                )
                                .ok()
                                .map(|naive| naive.and_utc())
                            })
                            .map(|start| (start + chrono::Duration::minutes(minutes)).to_rfc3339())
                    } else if trimmed.len() >= 16 {
                        Some(trimmed.to_string())
                    } else {
                        None
                    }
                },
            })
        } else {
            None
        },
    })
}

/// Build a receipt document for a single split payment.
///
/// The `payment_id` identifies which payment to print. If payment_items
/// exist for this payment, only those items are shown. Otherwise all order
/// items are included with a "Split Payment" header. Only the single
/// payment line is shown.
fn build_split_receipt_doc(db: &DbState, payment_id: &str) -> Result<OrderReceiptDoc, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Load the payment record
    let (
        order_id,
        method,
        amount,
        cash_received,
        change_given,
        transaction_ref,
        discount_amount,
    ): (
        String,
        String,
        f64,
        Option<f64>,
        Option<f64>,
        String,
        f64,
    ) = conn
        .query_row(
            "SELECT order_id, COALESCE(method, ''), COALESCE(amount, 0),
                    cash_received, change_given, COALESCE(transaction_ref, ''),
                    COALESCE(discount_amount, 0)
             FROM order_payments WHERE id = ?1 AND status = 'completed'",
            params![payment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|_| format!("Payment not found or not completed: {payment_id}"))?;

    // Load order header
    let (
        order_number,
        order_type,
        status,
        created_at,
        table_number,
        customer_name,
        customer_phone,
        items_json,
        total_amount,
    ): (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        f64,
    ) = conn
        .query_row(
            "SELECT COALESCE(NULLIF(display_order_number, ''), order_number, ''), COALESCE(order_type, ''), COALESCE(status, ''),
                    COALESCE(created_at, ''), COALESCE(table_number, ''), COALESCE(customer_name, ''),
                    COALESCE(customer_phone, ''), COALESCE(items, '[]'), COALESCE(total_amount, 0)
             FROM orders WHERE id = ?1",
            params![order_id],
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
        .map_err(|_| format!("Order not found for payment: {payment_id}"))?;

    // Check for payment_items (split-by-items mode)
    let mut pi_stmt = conn
        .prepare(
            "SELECT item_index, item_name, item_quantity, item_amount
             FROM payment_items WHERE payment_id = ?1
             ORDER BY item_index ASC",
        )
        .map_err(|e| format!("prepare payment_items: {e}"))?;

    let payment_items: Vec<(i32, String, i32, f64)> = pi_stmt
        .query_map(params![payment_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| format!("query payment_items: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let menu_lookup = build_menu_category_lookup(&conn);

    // Build items list: payment_items if present, otherwise all order items
    let items: Vec<ReceiptItem> = if !payment_items.is_empty() {
        payment_items
            .iter()
            .map(|(_idx, name, qty, amt)| ReceiptItem {
                name: name.clone(),
                quantity: *qty as f64,
                total: *amt,
                category_name: None,
                subcategory_name: None,
                category_path: None,
                note: None,
                customizations: Vec::new(),
            })
            .collect()
    } else {
        // No payment_items — show all order items
        serde_json::from_str::<Value>(&items_json)
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .map(|item| {
                let category_fields = resolve_item_category_fields(&item, &menu_lookup);
                ReceiptItem {
                    name: item
                        .get("name")
                        .or_else(|| item.get("itemName"))
                        .or_else(|| item.get("menu_item_name"))
                        .or_else(|| item.get("title"))
                        .and_then(Value::as_str)
                        .unwrap_or("Item")
                        .to_string(),
                    quantity: item.get("quantity").and_then(parse_number).unwrap_or(1.0),
                    total: parse_item_total(&item),
                    category_name: category_fields.category_name,
                    subcategory_name: category_fields.subcategory_name,
                    category_path: category_fields.category_path,
                    note: build_item_note_text(&item),
                    customizations: parse_item_customizations(&item),
                }
            })
            .collect()
    };

    // Build totals: show gross subtotal, optional discount, and the net paid amount.
    let inferred_gross_subtotal = if !payment_items.is_empty() {
        items.iter().map(|i| i.total).sum()
    } else {
        amount + discount_amount.max(0.0)
    };
    let mut totals = vec![TotalsLine {
        label: "Subtotal".to_string(),
        amount: inferred_gross_subtotal,
        emphasize: false,
        discount_percent: None,
    }];
    if discount_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Discount".to_string(),
            amount: -discount_amount,
            emphasize: false,
            discount_percent: None,
        });
    }
    totals.push(TotalsLine {
        label: "Split Payment".to_string(),
        amount,
        emphasize: true,
        discount_percent: None,
    });

    // Build the single payment line
    let label = match method.as_str() {
        "cash" => "Cash",
        "card" => "Card",
        _ => "Other",
    };
    let normalized_amount = if method == "cash" {
        cash_received.filter(|r| *r > 0.0).unwrap_or(amount)
    } else {
        amount
    };
    let mut payments = vec![PaymentLine {
        label: label.to_string(),
        amount: normalized_amount,
        detail: None,
    }];
    if let Some(change) = change_given {
        if change > 0.0 {
            payments.push(PaymentLine {
                label: "Change".to_string(),
                amount: change,
                detail: None,
            });
        }
    }

    let masked_card = if method == "card" {
        extract_masked_card_reference(&transaction_ref)
    } else {
        None
    };

    // Add a note indicating this is a split payment receipt
    let mut order_notes = Vec::new();
    let split_note = format!("Split Payment ({:.2} of {:.2} total)", amount, total_amount);
    order_notes.push(split_note);
    if discount_amount > 0.0 {
        order_notes.push(format!("Includes split discount of {:.2}", discount_amount));
    }

    Ok(OrderReceiptDoc {
        order_id: order_id.to_string(),
        order_number: if order_number.is_empty() {
            order_id.to_string()
        } else {
            order_number
        },
        order_type,
        status,
        created_at,
        table_number: non_empty_field(table_number),
        customer_name: non_empty_field(customer_name),
        customer_phone: non_empty_field(customer_phone),
        delivery_address: None,
        delivery_city: None,
        delivery_postal_code: None,
        delivery_floor: None,
        name_on_ringer: None,
        driver_id: None,
        driver_name: None,
        delivery_slip_mode: DeliverySlipMode::DeliveryOrder,
        items,
        totals,
        payments,
        adjustments: Vec::new(),
        masked_card,
        order_notes,
        status_label: None,
        cancellation_reason: None,
        platform_slip: None,
    })
}

/// Rider-facing banner for platform orders (THE-434, Plan-B first version —
/// the faithful efood-template pass follows once reference slips exist): the
/// platform name plus the short code riders match orders by, plus the payment
/// line the handoff depends on (collect X€ vs already paid).
/// Food-delivery platforms whose slips are handed to an external rider.
/// Internal sources (`pos`, `kiosk`, `web`, `android-ios`) deliberately fail
/// this check: the kiosk route stores `platform = 'web'`, and those receipts
/// must not grow a rider banner. Mirrors KNOWN_EXTERNAL_PLUGINS (delivery
/// subset) in src/renderer/utils/plugin-icons.tsx.
pub(crate) fn is_food_delivery_plugin(plugin: &str) -> bool {
    matches!(
        plugin.trim().to_ascii_lowercase().as_str(),
        "efood"
            | "wolt"
            | "box"
            | "glovo"
            | "bolt_food"
            | "uber_eats"
            | "just_eat_takeaway"
            | "deliveroo"
            | "foodora"
            | "smood"
    )
}

/// The rider-facing 4-digit code from ghost_metadata.food_delivery — the
/// number efood's own slip prints huge («#4545») and riders match orders by.
fn food_delivery_short_code(ghost_metadata_json: &str) -> Option<String> {
    serde_json::from_str::<Value>(ghost_metadata_json)
        .ok()?
        .get("food_delivery")?
        .get("short_code")?
        .as_str()
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .map(str::to_string)
}

fn platform_slip_banner(
    plugin: &str,
    ghost_metadata_json: &str,
    payment_status: &str,
    total_amount: f64,
) -> Option<String> {
    let plugin = plugin.trim();
    if !is_food_delivery_plugin(plugin) {
        return None;
    }
    let food_delivery = serde_json::from_str::<Value>(ghost_metadata_json)
        .ok()
        .and_then(|metadata| metadata.get("food_delivery").cloned())
        .unwrap_or(Value::Null);
    let short_code = food_delivery
        .get("short_code")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let prepaid = food_delivery.get("prepaid").and_then(Value::as_bool);
    let method = food_delivery
        .get("payment_method")
        .and_then(Value::as_str)
        .unwrap_or("");

    let mut banner = plugin.to_uppercase();
    if !short_code.is_empty() {
        banner.push_str(&format!(" #{short_code}"));
    }
    if prepaid == Some(true) || payment_status.eq_ignore_ascii_case("paid") {
        banner.push_str(" · ΠΛΗΡΩΜΕΝΗ");
    } else if method.eq_ignore_ascii_case("cash") {
        banner.push_str(&format!(" · ΑΝΤΙΚΑΤΑΒΟΛΗ {total_amount:.2}€"));
    }
    Some(banner)
}

/// The ingest appends a "--- Order Items ---" text fallback to
/// special_instructions on platform orders (a relic of the pre-order_items
/// era). When the document prints real item rows, that block duplicates them
/// on paper — keep only the customer's own note above the marker.
fn strip_platform_items_fallback(special_instructions: &str, has_items: bool) -> String {
    if !has_items {
        return special_instructions.to_string();
    }
    match special_instructions.find("--- Order Items ---") {
        Some(index) => special_instructions[..index].trim_end().to_string(),
        None => special_instructions.to_string(),
    }
}

fn build_kitchen_ticket_doc(db: &DbState, order_id: &str) -> Result<KitchenTicketDoc, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (
        order_number,
        order_type,
        created_at,
        table_number,
        delivery_address,
        delivery_notes,
        special_instructions,
        items_json,
        delivery_city,
        delivery_postal_code,
        delivery_floor,
        name_on_ringer,
        driver_name,
        customer_name,
        customer_phone,
        ghost_metadata,
    ) = conn
        .query_row(
            "SELECT COALESCE(NULLIF(display_order_number, ''), order_number, ''), COALESCE(order_type, ''), COALESCE(created_at, ''),
                    COALESCE(table_number, ''), COALESCE(delivery_address, ''), COALESCE(delivery_notes, ''),
                    COALESCE(special_instructions, ''), COALESCE(items, '[]'),
                    COALESCE(delivery_city, ''), COALESCE(delivery_postal_code, ''),
                    COALESCE(delivery_floor, ''), COALESCE(name_on_ringer, ''),
                    COALESCE(driver_name, ''), COALESCE(customer_name, ''),
                    COALESCE(customer_phone, ''), COALESCE(ghost_metadata, '')
             FROM orders WHERE id = ?1",
            params![order_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                    row.get::<_, String>(15)?,
                ))
            },
        )
        .map_err(|_| format!("Order not found: {order_id}"))?;
    let menu_lookup = build_menu_category_lookup(&conn);

    let items: Vec<ReceiptItem> = serde_json::from_str::<Value>(&items_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            let category_fields = resolve_item_category_fields(&item, &menu_lookup);
            ReceiptItem {
                name: item
                    .get("name")
                    .or_else(|| item.get("itemName"))
                    .or_else(|| item.get("menu_item_name"))
                    .or_else(|| item.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("Item")
                    .to_string(),
                quantity: item.get("quantity").and_then(parse_number).unwrap_or(1.0),
                total: parse_item_total(&item),
                category_name: category_fields.category_name,
                subcategory_name: category_fields.subcategory_name,
                category_path: category_fields.category_path,
                note: build_item_note_text(&item),
                customizations: parse_item_customizations(&item),
            }
        })
        .collect();

    Ok(KitchenTicketDoc {
        order_id: order_id.to_string(),
        // Platform orders: the kitchen matches bags to riders by the same
        // 4-digit short code the receipt and efood's own slip headline.
        order_number: food_delivery_short_code(&ghost_metadata).unwrap_or(
            if order_number.is_empty() {
                order_id.to_string()
            } else {
                order_number
            },
        ),
        order_type,
        created_at,
        table_number: if table_number.is_empty() {
            None
        } else {
            Some(table_number)
        },
        delivery_address: if delivery_address.is_empty() {
            None
        } else {
            Some(delivery_address)
        },
        delivery_notes: if delivery_notes.is_empty() {
            None
        } else {
            Some(delivery_notes)
        },
        special_instructions: {
            let mut notes = Vec::new();
            let special_instructions =
                strip_platform_items_fallback(&special_instructions, !items.is_empty());
            push_unique_trimmed_note(&mut notes, Some(&special_instructions));
            let kiosk_context_note = kiosk_context_note_from_metadata(&ghost_metadata);
            push_unique_trimmed_note(&mut notes, kiosk_context_note.as_deref());
            if notes.is_empty() {
                None
            } else {
                Some(notes.join("\n"))
            }
        },
        delivery_city: if delivery_city.is_empty() {
            None
        } else {
            Some(delivery_city)
        },
        delivery_postal_code: if delivery_postal_code.is_empty() {
            None
        } else {
            Some(delivery_postal_code)
        },
        delivery_floor: if delivery_floor.is_empty() {
            None
        } else {
            Some(delivery_floor)
        },
        name_on_ringer: if name_on_ringer.is_empty() {
            None
        } else {
            Some(name_on_ringer)
        },
        driver_name: if driver_name.is_empty() {
            None
        } else {
            Some(driver_name)
        },
        customer_name: if customer_name.is_empty() {
            None
        } else {
            Some(customer_name)
        },
        customer_phone: if customer_phone.is_empty() {
            None
        } else {
            Some(customer_phone)
        },
        items,
    })
}

fn object_text_field(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .and_then(non_empty_text)
}

fn object_number_field(payload: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        payload.get(*key).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|number| number as f64))
                .or_else(|| {
                    value
                        .as_str()
                        .and_then(|text| text.trim().parse::<f64>().ok())
                })
        })
    })
}

fn build_shift_checkout_doc(
    db: &DbState,
    shift_id: &str,
    payload: Option<&Value>,
) -> Result<ShiftCheckoutDoc, String> {
    let summary = crate::shifts::get_shift_summary(db, shift_id)?;
    let shift = summary
        .get("shift")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let cash_drawer = summary
        .get("cashDrawer")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let explicit_terminal_name =
        payload.and_then(|value| object_text_field(value, &["terminalName", "terminal_name"]));
    let snapshot_check_out_time = payload.and_then(|value| {
        object_text_field(value, &["snapshotCheckOutTime", "snapshot_check_out_time"])
    });
    let snapshot_expected_amount = payload
        .and_then(|value| object_number_field(value, &["expectedAmount", "expected_amount"]));
    let snapshot_closing_amount =
        payload.and_then(|value| object_number_field(value, &["closingAmount", "closing_amount"]));
    let snapshot_variance_amount = payload
        .and_then(|value| object_number_field(value, &["varianceAmount", "variance_amount"]));
    let terminal_name = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        resolve_printed_terminal_name_with_conn(&conn, explicit_terminal_name.as_deref())
            .unwrap_or_default()
    };
    let transferred_staff_groups = [
        summary.get("transferredDrivers").and_then(Value::as_array),
        summary.get("transferredWaiters").and_then(Value::as_array),
    ];
    let mut transferred_staff_count = 0_i64;
    let mut transferred_staff_returns = 0.0_f64;
    for group in transferred_staff_groups.into_iter().flatten() {
        transferred_staff_count += group.len() as i64;
        transferred_staff_returns += group
            .iter()
            .map(|entry| {
                entry
                    .get("net_cash_amount")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            })
            .sum::<f64>();
    }
    let staff_payout_lines = summary
        .get("staffPayments")
        .and_then(Value::as_array)
        .map(|payments| {
            payments
                .iter()
                .map(|payment| crate::receipt_renderer::StaffPayoutLine {
                    staff_name: text_from_paths(payment, &["/staff_name", "/staffName"])
                        .unwrap_or_else(|| "Unknown".to_string()),
                    role_type: text_from_paths(payment, &["/role_type", "/roleType"])
                        .unwrap_or_else(|| "staff".to_string()),
                    amount: number_from_paths(payment, &["/amount"]).unwrap_or(0.0),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let staff_payouts_total = number_from_paths(
        &summary,
        &[
            "/staffPayments/total",
            "/cashDrawer/total_staff_payments",
            "/cashDrawer/totalStaffPayments",
            "/staffPaymentsTotal",
        ],
    )
    .unwrap_or_else(|| {
        staff_payout_lines
            .iter()
            .map(|line| line.amount)
            .sum::<f64>()
    });
    let expense_lines = summary
        .get("expenses")
        .and_then(Value::as_array)
        .map(|expenses| {
            expenses
                .iter()
                .map(|expense| crate::receipt_renderer::ZReportExpenseEntry {
                    reason: text_from_paths(expense, &["/description"]).unwrap_or_default(),
                    expense_type: text_from_paths(expense, &["/expense_type", "/expenseType"])
                        .unwrap_or_default(),
                    amount: number_from_paths(expense, &["/amount"]).unwrap_or(0.0),
                    created_at: text_from_paths(expense, &["/created_at", "/createdAt"]),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let resolved_role_type = payload
        .and_then(|value| object_text_field(value, &["roleType", "role_type"]))
        .or_else(|| {
            shift
                .get("role_type")
                .or_else(|| shift.get("roleType"))
                .and_then(Value::as_str)
                .and_then(non_empty_text)
        })
        .unwrap_or_else(|| "staff".to_string());
    let shift_status = shift
        .get("status")
        .or_else(|| shift.get("shiftStatus"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let persisted_cash_sales = number_from_paths(
        &summary,
        &[
            "/sales/cashSales",
            "/totals/cash_sales",
            "/shift/total_cash_sales",
            "/cashDrawer/total_cash_sales",
        ],
    );
    let persisted_card_sales = number_from_paths(
        &summary,
        &[
            "/sales/cardSales",
            "/totals/card_sales",
            "/shift/total_card_sales",
            "/cashDrawer/total_card_sales",
        ],
    );
    let is_active_cashier_checkout =
        shift_status == "active" && matches!(resolved_role_type.as_str(), "cashier" | "manager");
    let cash_sales = if is_active_cashier_checkout {
        number_from_paths(&summary, &["/breakdown/instore/cashTotal"])
            .or(persisted_cash_sales)
            .unwrap_or(0.0)
    } else {
        persisted_cash_sales.unwrap_or(0.0)
    };
    let card_sales = if is_active_cashier_checkout {
        number_from_paths(&summary, &["/breakdown/instore/cardTotal"])
            .or(persisted_card_sales)
            .unwrap_or(0.0)
    } else {
        persisted_card_sales.unwrap_or(0.0)
    };

    let mut doc = Ok(ShiftCheckoutDoc {
        shift_id: shift_id.to_string(),
        role_type: resolved_role_type,
        staff_name: shift
            .get("staff_name")
            .or_else(|| shift.get("staffName"))
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("Unknown")
            .to_string(),
        terminal_name,
        check_in: shift
            .get("check_in_time")
            .or_else(|| shift.get("checkInTime"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        check_out: snapshot_check_out_time
            .or_else(|| {
                shift
                    .get("check_out_time")
                    .or_else(|| shift.get("checkOutTime"))
                    .and_then(Value::as_str)
                    .map(|value| value.to_string())
            })
            .unwrap_or_default(),
        orders_count: summary
            .get("ordersCount")
            .and_then(Value::as_i64)
            .or_else(|| {
                number_from_paths(&shift, &["/total_orders_count", "/totalOrdersCount"])
                    .map(|v| v as i64)
            })
            .unwrap_or(0),
        sales_amount: number_from_paths(
            &summary,
            &[
                "/salesAmount",
                "/shift/total_sales_amount",
                "/shift/totalSalesAmount",
            ],
        )
        .unwrap_or(0.0),
        total_expenses: summary
            .get("totalExpenses")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        cash_refunds: summary
            .get("cashRefunds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        opening_amount: number_from_paths(&cash_drawer, &["/opening_amount", "/openingAmount"])
            .or_else(|| number_from_paths(&shift, &["/opening_cash_amount", "/openingCashAmount"]))
            .unwrap_or(0.0),
        cash_sales,
        card_sales,
        cash_drops: number_from_paths(&cash_drawer, &["/cash_drops", "/cashDrops"]).unwrap_or(0.0),
        driver_cash_given: number_from_paths(
            &cash_drawer,
            &["/driver_cash_given", "/driverCashGiven"],
        )
        .unwrap_or(0.0),
        driver_cash_returned: number_from_paths(
            &cash_drawer,
            &["/driver_cash_returned", "/driverCashReturned"],
        )
        .unwrap_or(0.0),
        staff_payouts_total,
        staff_payout_lines,
        expense_lines,
        transferred_staff_count,
        transferred_staff_returns,
        expected_amount: snapshot_expected_amount.or_else(|| {
            number_from_paths(&cash_drawer, &["/expected_amount", "/expectedAmount"]).or_else(
                || number_from_paths(&shift, &["/expected_cash_amount", "/expectedCashAmount"]),
            )
        }),
        closing_amount: snapshot_closing_amount.or_else(|| {
            number_from_paths(&cash_drawer, &["/closing_amount", "/closingAmount"]).or_else(|| {
                number_from_paths(&shift, &["/closing_cash_amount", "/closingCashAmount"])
            })
        }),
        variance_amount: snapshot_variance_amount.or_else(|| {
            number_from_paths(&cash_drawer, &["/variance_amount", "/varianceAmount"])
                .or_else(|| number_from_paths(&shift, &["/cash_variance", "/cashVariance"]))
        }),
        driver_deliveries: Vec::new(),
        total_cash_collected: 0.0,
        total_card_collected: 0.0,
        total_delivery_fees: 0.0,
        total_tips: 0.0,
        tips_received: number_from_paths(&summary, &["/tipsReceived", "/tips_received"])
            .unwrap_or(0.0),
        amount_to_return: 0.0,
        total_sells: 0.0,
        cancelled_or_refunded_total: 0.0,
        cancelled_or_refunded_count: 0,
    });

    // Populate driver-specific fields
    let role = doc.as_ref().map(|d| d.role_type.as_str()).unwrap_or("");
    if role == "driver" {
        let mut cash_total = number_from_paths(
            &summary,
            &[
                "/breakdown/delivery/cashTotal",
                "/breakdown/overall/cashTotal",
            ],
        )
        .unwrap_or(0.0);
        let mut card_total = number_from_paths(
            &summary,
            &[
                "/breakdown/delivery/cardTotal",
                "/breakdown/overall/cardTotal",
            ],
        )
        .unwrap_or(0.0);
        let mut lines = Vec::new();
        let mut fees_total = 0.0_f64;
        let mut tips_total = 0.0_f64;
        let mut cancelled_or_refunded_total = 0.0_f64;
        let mut cancelled_or_refunded_count = 0_i64;

        if let Some(deliveries) = summary.get("driverDeliveries").and_then(Value::as_array) {
            let mut delivery_cash_total = 0.0_f64;
            let mut delivery_card_total = 0.0_f64;

            for d in deliveries {
                let cash = d
                    .get("cash_collected")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let card = d.get("card_amount").and_then(Value::as_f64).unwrap_or(0.0);
                let fee = d.get("delivery_fee").and_then(Value::as_f64).unwrap_or(0.0);
                let tip = d.get("tip_amount").and_then(Value::as_f64).unwrap_or(0.0);
                let total = d.get("total_amount").and_then(Value::as_f64).unwrap_or(0.0);
                let status = d.get("status").and_then(Value::as_str).unwrap_or("");
                let is_cancelled_or_refunded = is_cancelled_or_refunded_status(status);

                if is_cancelled_or_refunded {
                    cancelled_or_refunded_total += total;
                    cancelled_or_refunded_count += 1;
                } else {
                    delivery_cash_total += cash;
                    delivery_card_total += card;
                    fees_total += fee;
                    tips_total += tip;
                }

                lines.push(crate::receipt_renderer::DriverDeliveryLine {
                    order_number: d
                        .get("order_number")
                        .and_then(Value::as_str)
                        .unwrap_or("N/A")
                        .to_string(),
                    delivery_address: text_from_paths(
                        d,
                        &["/delivery_address", "/deliveryAddress"],
                    ),
                    total_amount: total,
                    payment_method: d
                        .get("payment_method")
                        .and_then(Value::as_str)
                        .unwrap_or("cash")
                        .to_string(),
                    cash_collected: cash,
                    delivery_fee: fee,
                    tip_amount: tip,
                    status: status.to_string(),
                });
            }
            if !lines.is_empty() {
                cash_total = delivery_cash_total;
                card_total = delivery_card_total;
            }
        }

        if let Ok(ref mut doc) = doc {
            let opening = doc.opening_amount;
            let expenses = doc.total_expenses;
            doc.driver_deliveries = lines;
            doc.total_cash_collected = cash_total;
            doc.total_card_collected = card_total;
            doc.total_delivery_fees = fees_total;
            doc.total_tips = if doc.tips_received > 0.0 {
                doc.tips_received
            } else {
                tips_total
            };
            doc.total_sells = cash_total + card_total;
            doc.cancelled_or_refunded_total = cancelled_or_refunded_total;
            doc.cancelled_or_refunded_count = cancelled_or_refunded_count;
            doc.amount_to_return = crate::shifts::calculate_driver_return(
                opening,
                cash_total,
                expenses,
                doc.total_tips,
            );
        }
    }

    doc
}

fn is_cancelled_or_refunded_status(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "cancelled" | "canceled" | "refunded"
    )
}

fn number_from_paths(payload: &Value, paths: &[&str]) -> Option<f64> {
    for path in paths {
        if let Some(value) = payload.pointer(path) {
            if let Some(number) = value.as_f64() {
                return Some(number);
            }
            if let Some(number) = value.as_i64() {
                return Some(number as f64);
            }
            if let Some(text) = value.as_str() {
                if let Ok(number) = text.trim().parse::<f64>() {
                    return Some(number);
                }
            }
        }
    }
    None
}

fn text_from_paths(payload: &Value, paths: &[&str]) -> Option<String> {
    for path in paths {
        if let Some(text) = payload.pointer(path).and_then(Value::as_str) {
            if let Some(trimmed) = non_empty_text(text) {
                return Some(trimmed);
            }
        }
    }
    None
}

fn z_report_expense_entries(payload: &Value) -> Vec<receipt_renderer::ZReportExpenseEntry> {
    payload
        .pointer("/expenses/items")
        .or_else(|| payload.get("expenseItems"))
        .or_else(|| payload.get("expense_items"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let expense_type =
                        text_from_paths(item, &["/expenseType", "/expense_type", "/type"])
                            .unwrap_or_default();
                    let reason =
                        text_from_paths(item, &["/description", "/reason", "/notes", "/note"])
                            .filter(|value| !value.trim().is_empty())
                            .or_else(|| {
                                if expense_type.trim().is_empty() {
                                    None
                                } else {
                                    Some(expense_type.clone())
                                }
                            })
                            .unwrap_or_default();
                    let amount =
                        number_from_paths(item, &["/amount", "/total"]).unwrap_or_else(|| {
                            number_from_paths(item, &["/amountCents", "/amount_cents"])
                                .unwrap_or(0.0)
                                / 100.0
                        });

                    receipt_renderer::ZReportExpenseEntry {
                        reason,
                        expense_type,
                        amount,
                        created_at: text_from_paths(
                            item,
                            &["/createdAt", "/created_at", "/timestamp"],
                        ),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn z_report_staff_payment_entries(
    payload: &Value,
) -> Vec<receipt_renderer::ZReportStaffPaymentEntry> {
    let reports = payload
        .get("staffReports")
        .or_else(|| payload.get("staff_reports"))
        .and_then(Value::as_array);
    let Some(reports) = reports else {
        return Vec::new();
    };

    let mut itemized = Vec::<(String, receipt_renderer::ZReportStaffPaymentEntry, bool)>::new();
    let mut item_index = HashMap::<String, usize>::new();

    for report in reports {
        let report_name =
            text_from_paths(report, &["/staffName", "/staff_name", "/name"]).unwrap_or_default();
        let report_role =
            text_from_paths(report, &["/role", "/roleType", "/role_type"]).unwrap_or_default();
        let report_is_probable_recipient = !matches!(report_role.as_str(), "cashier" | "manager");

        let Some(payments) = report
            .pointer("/payments/list")
            .or_else(|| report.pointer("/staffPayments/items"))
            .and_then(Value::as_array)
        else {
            continue;
        };

        for (payment_offset, payment) in payments.iter().enumerate() {
            let amount = number_from_paths(payment, &["/amount", "/total"]).unwrap_or_else(|| {
                number_from_paths(payment, &["/amountCents", "/amount_cents"]).unwrap_or(0.0)
                    / 100.0
            });
            if amount == 0.0 {
                continue;
            }

            let explicit_staff_name = text_from_paths(
                payment,
                &[
                    "/staffName",
                    "/staff_name",
                    "/paidToStaffName",
                    "/paid_to_staff_name",
                ],
            );
            let explicit_role = text_from_paths(payment, &["/role", "/roleType", "/role_type"]);
            let staff_name = explicit_staff_name
                .clone()
                .unwrap_or_else(|| report_name.clone());
            let role = explicit_role.unwrap_or_else(|| report_role.clone());
            let reason = text_from_paths(payment, &["/notes", "/note", "/description", "/reason"])
                .unwrap_or_default();
            let payment_id = text_from_paths(payment, &["/id", "/paymentId", "/payment_id"])
                .unwrap_or_else(|| {
                    format!("{}:{}:{}:{}", report_name, amount, reason, payment_offset)
                });
            let is_probable_recipient =
                explicit_staff_name.is_some() || report_is_probable_recipient;
            let entry = receipt_renderer::ZReportStaffPaymentEntry {
                staff_name,
                role,
                reason,
                amount,
                created_at: text_from_paths(payment, &["/createdAt", "/created_at", "/timestamp"]),
            };

            if let Some(existing_index) = item_index.get(&payment_id).copied() {
                if is_probable_recipient && !itemized[existing_index].2 {
                    itemized[existing_index] = (payment_id.clone(), entry, is_probable_recipient);
                }
            } else {
                item_index.insert(payment_id.clone(), itemized.len());
                itemized.push((payment_id, entry, is_probable_recipient));
            }
        }
    }

    if !itemized.is_empty() {
        return itemized.into_iter().map(|(_, entry, _)| entry).collect();
    }

    // Older persisted reports may contain only one aggregate per staff member.
    // Prefer recipient shifts over cashier/manager outflow summaries so the same
    // payout is not presented twice.
    let mut aggregate_entries = reports
        .iter()
        .filter_map(|report| {
            let amount = number_from_paths(
                report,
                &[
                    "/payments/staffPayments",
                    "/payments/staff_payments",
                    "/staffPayments",
                    "/staff_payments",
                ],
            )
            .unwrap_or(0.0);
            if amount == 0.0 {
                return None;
            }
            let role =
                text_from_paths(report, &["/role", "/roleType", "/role_type"]).unwrap_or_default();
            Some(receipt_renderer::ZReportStaffPaymentEntry {
                staff_name: text_from_paths(report, &["/staffName", "/staff_name", "/name"])
                    .unwrap_or_default(),
                role,
                reason: String::new(),
                amount,
                created_at: None,
            })
        })
        .collect::<Vec<_>>();
    if aggregate_entries
        .iter()
        .any(|entry| !matches!(entry.role.as_str(), "cashier" | "manager"))
    {
        aggregate_entries.retain(|entry| !matches!(entry.role.as_str(), "cashier" | "manager"));
    }
    aggregate_entries
}

fn build_z_report_doc_from_payload(db: &DbState, payload: &Value, entity_id: &str) -> ZReportDoc {
    let report_date = text_from_paths(payload, &["/date", "/reportDate", "/report_date"])
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
    let generated_at = text_from_paths(payload, &["/generatedAt", "/generated_at"])
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let total_orders = number_from_paths(
        payload,
        &[
            "/sales/totalOrders",
            "/sales/total_orders",
            "/daySummary/totalOrders",
            "/totalOrders",
        ],
    )
    .unwrap_or(0.0)
    .round() as i64;
    let gross_sales = number_from_paths(
        payload,
        &[
            "/sales/totalSales",
            "/sales/total_sales",
            "/daySummary/total",
            "/daySummary/totalAmount",
        ],
    )
    .unwrap_or(0.0);
    let cash_sales = number_from_paths(
        payload,
        &[
            "/sales/cashSales",
            "/sales/cash_sales",
            "/daySummary/cashTotal",
        ],
    )
    .unwrap_or(0.0);
    let drawer_cash_sales =
        number_from_paths(payload, &["/cashDrawer/cashSales", "/drawerCashSales"]);
    let card_sales = number_from_paths(
        payload,
        &[
            "/sales/cardSales",
            "/sales/card_sales",
            "/daySummary/cardTotal",
        ],
    )
    .unwrap_or(0.0);
    let refunds_total = number_from_paths(
        payload,
        &["/refunds/total", "/refundsTotal", "/refunds_total"],
    )
    .unwrap_or(0.0);
    let drawer_refunds_total = number_from_paths(
        payload,
        &["/cashDrawer/totalRefunds", "/drawerRefundsTotal"],
    );
    let voids_total =
        number_from_paths(payload, &["/voids/total", "/voidsTotal", "/voids_total"]).unwrap_or(0.0);
    let discounts_total = number_from_paths(
        payload,
        &["/discounts/total", "/discountsTotal", "/discounts_total"],
    )
    .unwrap_or(0.0);
    let expenses_total = number_from_paths(
        payload,
        &["/expenses/total", "/expensesTotal", "/expenses_total"],
    )
    .unwrap_or(0.0);
    let drawer_expenses_total = number_from_paths(
        payload,
        &["/cashDrawer/totalExpenses", "/drawerExpensesTotal"],
    );
    let cash_variance = number_from_paths(
        payload,
        &[
            "/cashDrawer/totalVariance",
            "/cashDrawer/cashVariance",
            "/cashVariance",
        ],
    )
    .unwrap_or(0.0);
    let net_sales = gross_sales - discounts_total - refunds_total - voids_total;
    let tips_total =
        number_from_paths(payload, &["/tips/total", "/tipsTotal", "/tips_total"]).unwrap_or(0.0);
    let opening_cash = number_from_paths(
        payload,
        &["/cashDrawer/openingTotal", "/openingCash", "/opening_cash"],
    )
    .unwrap_or(0.0);
    let closing_cash = number_from_paths(
        payload,
        &[
            "/cashDrawer/moneyInDrawer",
            "/cashDrawer/money_in_drawer",
            "/moneyInDrawer",
            "/money_in_drawer",
            "/cashDrawer/closing",
            "/closingCash",
            "/closing_cash",
        ],
    )
    .unwrap_or(0.0);
    let expected_cash = number_from_paths(
        payload,
        &["/cashDrawer/expected", "/expectedCash", "/expected_cash"],
    )
    .unwrap_or(0.0);
    let cash_drops =
        number_from_paths(payload, &["/cashDrawer/totalCashDrops", "/cashDrops"]).unwrap_or(0.0);
    let driver_cash_given = number_from_paths(
        payload,
        &["/cashDrawer/driverCashGiven", "/driverCashGiven"],
    )
    .unwrap_or(0.0);
    let driver_cash_returned = number_from_paths(
        payload,
        &["/cashDrawer/driverCashReturned", "/driverCashReturned"],
    )
    .unwrap_or(0.0);
    let staff_payment_lines = z_report_staff_payment_entries(payload);
    let staff_payments_total = number_from_paths(
        payload,
        &[
            "/staffPayments/total",
            "/cashDrawer/staffPaymentsTotal",
            "/staffPaymentsTotal",
        ],
    )
    .unwrap_or_else(|| staff_payment_lines.iter().map(|entry| entry.amount).sum());
    let dine_in_orders = number_from_paths(payload, &["/sales/dineInOrders", "/dineInOrders"])
        .unwrap_or(0.0)
        .round() as i64;
    let dine_in_sales =
        number_from_paths(payload, &["/sales/dineInSales", "/dineInSales"]).unwrap_or(0.0);
    let takeaway_orders = number_from_paths(payload, &["/sales/takeawayOrders", "/takeawayOrders"])
        .unwrap_or(0.0)
        .round() as i64;
    let takeaway_sales =
        number_from_paths(payload, &["/sales/takeawaySales", "/takeawaySales"]).unwrap_or(0.0);
    let delivery_orders = number_from_paths(payload, &["/sales/deliveryOrders", "/deliveryOrders"])
        .unwrap_or(0.0)
        .round() as i64;
    let delivery_sales =
        number_from_paths(payload, &["/sales/deliverySales", "/deliverySales"]).unwrap_or(0.0);
    let shift_count = number_from_paths(payload, &["/shiftCount", "/shift_count", "/shifts/total"])
        .map(|value| value.round() as i64)
        .filter(|count| *count > 0);
    let mut shift_ref = text_from_paths(payload, &["/shiftId", "/shift_id"]).unwrap_or_default();
    if shift_count.unwrap_or(0) > 1 {
        shift_ref.clear();
    }
    let explicit_terminal_name = text_from_paths(payload, &["/terminalName", "/terminal_name"]);
    let terminal_name = db
        .conn
        .lock()
        .ok()
        .and_then(|conn| {
            resolve_printed_terminal_name_with_conn(&conn, explicit_terminal_name.as_deref())
        })
        .unwrap_or_default();

    ZReportDoc {
        report_id: entity_id.to_string(),
        report_date,
        generated_at,
        shift_ref,
        shift_count,
        terminal_name,
        total_orders,
        gross_sales,
        net_sales,
        cash_sales,
        drawer_cash_sales,
        card_sales,
        platform_online_sales: number_from_paths(
            payload,
            &[
                "/sales/platformOnlineSales",
                "/daySummary/platformOnlineTotal",
            ],
        )
        .unwrap_or(0.0),
        platform_cod_sales: number_from_paths(
            payload,
            &["/sales/platformCodSales", "/daySummary/platformCodTotal"],
        )
        .unwrap_or(0.0),
        refunds_total,
        drawer_refunds_total,
        voids_total,
        discounts_total,
        expenses_total,
        drawer_expenses_total,
        cash_variance,
        tips_total,
        opening_cash,
        closing_cash,
        expected_cash,
        cash_drops,
        driver_cash_given,
        driver_cash_returned,
        staff_payments_total,
        dine_in_orders,
        dine_in_sales,
        takeaway_orders,
        takeaway_sales,
        delivery_orders,
        delivery_sales,
        expense_lines: z_report_expense_entries(payload),
        staff_payment_lines,
        staff_reports: payload
            .get("staffReports")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|s| receipt_renderer::ZReportStaffEntry {
                        name: s
                            .get("staffName")
                            .and_then(Value::as_str)
                            .unwrap_or("—")
                            .to_string(),
                        role: s
                            .get("role")
                            .and_then(Value::as_str)
                            .unwrap_or("cashier")
                            .to_string(),
                        check_in: s
                            .get("checkIn")
                            .and_then(Value::as_str)
                            .map(|v| v.to_string()),
                        check_out: s
                            .get("checkOut")
                            .and_then(Value::as_str)
                            .map(|v| v.to_string()),
                        order_count: s
                            .pointer("/orders/count")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        cash_amount: s
                            .pointer("/orders/cashAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        card_amount: s
                            .pointer("/orders/cardAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        total_amount: s
                            .pointer("/orders/totalAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        opening_cash: s
                            .pointer("/drawer/opening")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        staff_payment: s
                            .pointer("/payments/staffPayments")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        tips_received: s
                            .pointer("/driver/tips")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn build_z_report_doc(db: &DbState, z_report_id: &str) -> Result<ZReportDoc, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let report = conn.query_row(
        "SELECT id, shift_id, terminal_id, report_date, generated_at,
                gross_sales, net_sales, total_orders, cash_sales, card_sales,
                refunds_total, voids_total, discounts_total, expenses_total,
                cash_variance, tips_total, opening_cash, closing_cash, expected_cash,
                report_json
         FROM z_reports WHERE id = ?1",
        params![z_report_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, f64>(5)?,
                row.get::<_, f64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, f64>(8)?,
                row.get::<_, f64>(9)?,
                row.get::<_, f64>(10)?,
                row.get::<_, f64>(11)?,
                row.get::<_, f64>(12)?,
                row.get::<_, f64>(13)?,
                row.get::<_, f64>(14)?,
                row.get::<_, f64>(15).unwrap_or(0.0),
                row.get::<_, f64>(16).unwrap_or(0.0),
                row.get::<_, f64>(17).unwrap_or(0.0),
                row.get::<_, f64>(18).unwrap_or(0.0),
                row.get::<_, String>(19)?,
            ))
        },
    );

    let (
        report_id,
        raw_shift_ref,
        _terminal_id,
        report_date,
        generated_at,
        gross_sales,
        net_sales,
        total_orders,
        cash_sales,
        card_sales,
        refunds_total,
        voids_total,
        discounts_total,
        expenses_total,
        cash_variance,
        tips_total,
        opening_cash,
        closing_cash,
        expected_cash,
        report_json_str,
    ) = report.map_err(|_| format!("Z-report not found: {z_report_id}"))?;

    let rj: Value = serde_json::from_str(&report_json_str).unwrap_or_default();
    let shift_count = rj
        .pointer("/shifts/total")
        .and_then(Value::as_i64)
        .filter(|count| *count > 0);
    let shift_ref = if shift_count.unwrap_or(0) > 1 {
        String::new()
    } else {
        raw_shift_ref.unwrap_or_default()
    };
    let explicit_terminal_name = text_from_paths(&rj, &["/terminalName", "/terminal_name"]);
    let terminal_name =
        resolve_printed_terminal_name_with_conn(&conn, explicit_terminal_name.as_deref())
            .unwrap_or_default();
    let staff_payment_lines = z_report_staff_payment_entries(&rj);
    let staff_payments_total = number_from_paths(
        &rj,
        &[
            "/staffPayments/total",
            "/cashDrawer/staffPaymentsTotal",
            "/staffPaymentsTotal",
        ],
    )
    .unwrap_or_else(|| staff_payment_lines.iter().map(|entry| entry.amount).sum());
    // The JSON drawer snapshot is the authoritative physical-till view. Older
    // scalar columns could include driver wallet opening/closing amounts.
    let resolved_opening_cash =
        number_from_paths(&rj, &["/cashDrawer/openingTotal"]).unwrap_or(opening_cash);
    let resolved_closing_cash = number_from_paths(
        &rj,
        &[
            "/cashDrawer/moneyInDrawer",
            "/cashDrawer/money_in_drawer",
            "/cashDrawer/closing",
        ],
    )
    .unwrap_or(closing_cash);
    let resolved_expected_cash =
        number_from_paths(&rj, &["/cashDrawer/expected"]).unwrap_or(expected_cash);
    let resolved_cash_variance = number_from_paths(
        &rj,
        &["/cashDrawer/totalVariance", "/cashDrawer/cashVariance"],
    )
    .unwrap_or(cash_variance);
    let resolved_tips_total =
        number_from_paths(&rj, &["/tips/total", "/tipsTotal"]).unwrap_or(tips_total);

    Ok(ZReportDoc {
        report_id,
        report_date,
        generated_at,
        shift_ref,
        shift_count,
        terminal_name,
        total_orders,
        gross_sales,
        net_sales,
        cash_sales,
        drawer_cash_sales: number_from_paths(&rj, &["/cashDrawer/cashSales"]),
        card_sales,
        platform_online_sales: number_from_paths(
            &rj,
            &[
                "/sales/platformOnlineSales",
                "/daySummary/platformOnlineTotal",
            ],
        )
        .unwrap_or(0.0),
        platform_cod_sales: number_from_paths(
            &rj,
            &["/sales/platformCodSales", "/daySummary/platformCodTotal"],
        )
        .unwrap_or(0.0),
        refunds_total,
        drawer_refunds_total: number_from_paths(&rj, &["/cashDrawer/totalRefunds"]),
        voids_total,
        discounts_total,
        expenses_total,
        drawer_expenses_total: number_from_paths(&rj, &["/cashDrawer/totalExpenses"]),
        cash_variance: resolved_cash_variance,
        tips_total: resolved_tips_total,
        opening_cash: resolved_opening_cash,
        closing_cash: resolved_closing_cash,
        expected_cash: resolved_expected_cash,
        cash_drops: rj
            .pointer("/cashDrawer/totalCashDrops")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        driver_cash_given: rj
            .pointer("/cashDrawer/driverCashGiven")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        driver_cash_returned: rj
            .pointer("/cashDrawer/driverCashReturned")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        staff_payments_total,
        dine_in_orders: rj
            .pointer("/sales/dineInOrders")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        dine_in_sales: rj
            .pointer("/sales/dineInSales")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        takeaway_orders: rj
            .pointer("/sales/takeawayOrders")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        takeaway_sales: rj
            .pointer("/sales/takeawaySales")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        delivery_orders: rj
            .pointer("/sales/deliveryOrders")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        delivery_sales: rj
            .pointer("/sales/deliverySales")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        expense_lines: z_report_expense_entries(&rj),
        staff_payment_lines,
        staff_reports: rj
            .get("staffReports")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|s| receipt_renderer::ZReportStaffEntry {
                        name: s
                            .get("staffName")
                            .and_then(Value::as_str)
                            .unwrap_or("—")
                            .to_string(),
                        role: s
                            .get("role")
                            .and_then(Value::as_str)
                            .unwrap_or("cashier")
                            .to_string(),
                        check_in: s
                            .get("checkIn")
                            .and_then(Value::as_str)
                            .map(|v| v.to_string()),
                        check_out: s
                            .get("checkOut")
                            .and_then(Value::as_str)
                            .map(|v| v.to_string()),
                        order_count: s
                            .pointer("/orders/count")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        cash_amount: s
                            .pointer("/orders/cashAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        card_amount: s
                            .pointer("/orders/cardAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        total_amount: s
                            .pointer("/orders/totalAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        opening_cash: s
                            .pointer("/drawer/opening")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        staff_payment: s
                            .pointer("/payments/staffPayments")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        tips_received: s
                            .pointer("/driver/tips")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn build_document_for_job(
    db: &DbState,
    entity_type: &str,
    entity_id: &str,
    payload_json: Option<&str>,
) -> Result<ReceiptDocument, String> {
    let payload =
        payload_json.and_then(|raw_payload| serde_json::from_str::<Value>(raw_payload).ok());

    match entity_type {
        "order_receipt" => Ok(ReceiptDocument::OrderReceipt(build_order_receipt_doc(
            db, entity_id,
        )?)),
        "kitchen_ticket" => Ok(ReceiptDocument::KitchenTicket(build_kitchen_ticket_doc(
            db, entity_id,
        )?)),
        "shift_checkout" => Ok(ReceiptDocument::ShiftCheckout(build_shift_checkout_doc(
            db,
            entity_id,
            payload.as_ref(),
        )?)),
        "z_report" => {
            if let Some(payload) = payload.as_ref() {
                return Ok(ReceiptDocument::ZReport(build_z_report_doc_from_payload(
                    db, payload, entity_id,
                )));
            }
            Ok(ReceiptDocument::ZReport(build_z_report_doc(db, entity_id)?))
        }
        "delivery_slip" => {
            let mut doc = build_order_receipt_doc(db, entity_id)?;
            if let Some(payload) = payload.as_ref() {
                if let Some(mode) = object_text_field(payload, &["slip_mode", "slipMode"]) {
                    doc.delivery_slip_mode = if mode.eq_ignore_ascii_case("assign_driver") {
                        DeliverySlipMode::AssignDriver
                    } else {
                        DeliverySlipMode::DeliveryOrder
                    };
                }
                if doc.driver_id.is_none() {
                    doc.driver_id =
                        object_text_field(payload, &["driverId", "driver_id", "staff_id"]);
                }
                if doc.driver_name.is_none() {
                    doc.driver_name = object_text_field(payload, &["driverName", "driver_name"]);
                }
            }
            Ok(ReceiptDocument::DeliverySlip(doc))
        }
        "split_receipt" => {
            // entity_id is the payment_id for split receipts
            let doc = build_split_receipt_doc(db, entity_id)?;
            Ok(ReceiptDocument::OrderReceipt(doc))
        }
        "order_completed_receipt" => {
            let mut doc = build_order_receipt_doc(db, entity_id)?;
            doc.status_label = Some("\u{2713} COMPLETED".to_string());
            Ok(ReceiptDocument::OrderReceipt(doc))
        }
        "order_canceled_receipt" => {
            let mut doc = build_order_receipt_doc(db, entity_id)?;
            doc.status_label = Some("\u{2717} CANCELED".to_string());
            if let Some(payload) = payload.as_ref() {
                doc.cancellation_reason = payload
                    .get("cancellationReason")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
            }
            Ok(ReceiptDocument::OrderReceipt(doc))
        }
        _ => Err(format!("Unknown entity_type: {entity_type}")),
    }
}

/// Reject a path segment that could escape the receipts directory or
/// contain filesystem-hostile characters. POS entity ids (UUIDs, order
/// ids, z-report ids) are machine-generated and always match
/// `[A-Za-z0-9_-]{1,128}`, so this allowlist is tight without false
/// positives while blocking `..`, `/`, `\`, NUL, and every other path
/// traversal primitive.
fn sanitize_path_segment(label: &str, value: &str) -> Result<(), String> {
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

fn write_print_html_file(
    data_dir: &Path,
    entity_type: &str,
    entity_id: &str,
    html: &str,
) -> Result<String, String> {
    sanitize_path_segment("entity_type", entity_type)?;
    sanitize_path_segment("entity_id", entity_id)?;
    let receipts_dir = data_dir.join(RECEIPTS_DIR);
    fs::create_dir_all(&receipts_dir).map_err(|e| format!("create receipts dir: {e}"))?;
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    let filename = format!("{entity_type}_{entity_id}_{timestamp}.html");
    let file_path = receipts_dir.join(filename);
    fs::write(&file_path, html).map_err(|e| format!("write print artifact: {e}"))?;
    Ok(file_path.to_string_lossy().to_string())
}

struct ProvisionalPrintArtifact {
    artifact_ref: Uuid,
    path: PathBuf,
    receipts_dir: PathBuf,
    created_receipts_dir: bool,
    committed: bool,
}

impl ProvisionalPrintArtifact {
    fn create(
        data_dir: &Path,
        entity_type: &str,
        entity_id: &str,
        html: &str,
    ) -> Result<Self, String> {
        sanitize_path_segment("entity_type", entity_type)?;
        sanitize_path_segment("entity_id", entity_id)?;
        let receipts_dir = data_dir.join(RECEIPTS_DIR);
        fs::create_dir_all(data_dir).map_err(|e| format!("create print data dir: {e}"))?;
        let created_receipts_dir = match fs::create_dir(&receipts_dir) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(error) => return Err(format!("create receipts dir: {error}")),
        };
        let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
        let artifact_ref = Uuid::new_v4();
        let filename = format!("{entity_type}_{entity_id}_{timestamp}_{artifact_ref}.html");
        let path = receipts_dir.join(filename);
        let artifact = Self {
            artifact_ref,
            path,
            receipts_dir,
            created_receipts_dir,
            committed: false,
        };
        let write_result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&artifact.path)
                .map_err(|e| format!("create print artifact: {e}"))?;
            file.write_all(html.as_bytes())
                .map_err(|e| format!("write print artifact: {e}"))?;
            file.flush()
                .map_err(|e| format!("flush print artifact: {e}"))
        })();
        match write_result {
            Ok(()) => Ok(artifact),
            Err(error) => match artifact.rollback() {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(format!("{error}; {cleanup_error}")),
            },
        }
    }

    fn commit(mut self) -> String {
        self.committed = true;
        self.path.to_string_lossy().to_string()
    }

    fn rollback(mut self) -> Result<(), String> {
        self.cleanup()
    }

    #[cfg(test)]
    fn rollback_with_directory_retry_hook(
        mut self,
        after_initial_directory_not_empty: &dyn Fn(),
    ) -> Result<(), String> {
        self.cleanup_with_directory_retry_hook(after_initial_directory_not_empty)
    }

    fn cleanup(&mut self) -> Result<(), String> {
        self.cleanup_with_directory_retry_hook(&|| {})
    }

    fn cleanup_with_directory_retry_hook(
        &mut self,
        after_initial_directory_not_empty: &dyn Fn(),
    ) -> Result<(), String> {
        if self.committed {
            return Ok(());
        }
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "remove provisional print artifact failed (artifact_ref={}, kind={:?}, os_error={:?})",
                    self.artifact_ref,
                    error.kind(),
                    error.raw_os_error()
                ));
            }
        }
        if self.created_receipts_dir {
            match fs::remove_dir(&self.receipts_dir) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    after_initial_directory_not_empty();
                    match fs::read_dir(&self.receipts_dir) {
                        Err(read_error) if read_error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(read_error) => {
                            return Err(format!(
                                "inspect newly-created receipts directory after failed removal (artifact_ref={}, kind={:?}, os_error={:?})",
                                self.artifact_ref,
                                read_error.kind(),
                                read_error.raw_os_error()
                            ));
                        }
                        Ok(mut entries) => match entries.next() {
                            Some(Ok(_)) => {}
                            Some(Err(read_error)) => {
                                return Err(format!(
                                    "inspect entry in newly-created receipts directory after failed removal (artifact_ref={}, kind={:?}, os_error={:?})",
                                    self.artifact_ref,
                                    read_error.kind(),
                                    read_error.raw_os_error()
                                ));
                            }
                            None => match fs::remove_dir(&self.receipts_dir) {
                                Ok(()) => {}
                                Err(retry_error)
                                    if retry_error.kind() == std::io::ErrorKind::NotFound => {}
                                Err(retry_error) => {
                                    return Err(format!(
                                        "retry removal of newly-created receipts directory failed (artifact_ref={}, kind={:?}, os_error={:?})",
                                        self.artifact_ref,
                                        retry_error.kind(),
                                        retry_error.raw_os_error()
                                    ));
                                }
                            },
                        },
                    };
                }
            }
        }
        self.committed = true;
        Ok(())
    }
}

impl Drop for ProvisionalPrintArtifact {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            warn!(
                error = %error,
                "Best-effort provisional print artifact cleanup failed"
            );
        }
    }
}

fn rollback_provisional_artifact(
    artifact: &mut Option<ProvisionalPrintArtifact>,
    context: &str,
) -> Result<(), String> {
    match artifact.take() {
        Some(artifact) => artifact
            .rollback()
            .map_err(|error| format!("{context}: {error}")),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Receipt file generation
// ---------------------------------------------------------------------------

/// Generate a receipt HTML file for an order and write it to disk.
///
/// Returns the absolute path to the generated file.
pub fn generate_receipt_file(
    db: &DbState,
    order_id: &str,
    data_dir: &Path,
) -> Result<String, String> {
    let document = ReceiptDocument::OrderReceipt(build_order_receipt_doc(db, order_id)?);
    let profile = printers::resolve_printer_profile_for_role(db, None, Some("receipt"))?
        .unwrap_or_else(|| serde_json::json!({}));
    let layout = resolve_layout_config(db, &profile, "order_receipt")?;
    let html = receipt_renderer::render_html(&document, &layout);
    let path_str = write_print_html_file(data_dir, "receipt", order_id, &html)?;
    info!(order_id = %order_id, "Receipt file generated");
    Ok(path_str)
}

#[allow(dead_code)]
fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[allow(dead_code)]
fn generate_kitchen_ticket_file(
    db: &DbState,
    order_id: &str,
    data_dir: &Path,
) -> Result<String, String> {
    let (
        order_number,
        order_type,
        table_number,
        delivery_address,
        delivery_notes,
        special_instructions,
        created_at,
        items_json,
    ) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT
                COALESCE(NULLIF(display_order_number, ''), order_number, ''),
                COALESCE(order_type, ''),
                COALESCE(table_number, ''),
                COALESCE(delivery_address, ''),
                COALESCE(delivery_notes, ''),
                COALESCE(special_instructions, ''),
                COALESCE(created_at, ''),
                COALESCE(items, '[]')
             FROM orders
             WHERE id = ?1",
            params![order_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .map_err(|_| format!("Order not found: {order_id}"))?
    };

    let parsed_items: Vec<Value> = serde_json::from_str::<Value>(&items_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let mut items_html = String::new();
    for item in parsed_items {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Item")
            .trim();
        let qty = item.get("quantity").and_then(Value::as_f64).unwrap_or(1.0);
        let notes = build_item_note_text(&item).unwrap_or_default();
        items_html.push_str(&format!(
            "<li><strong>{:.0}x {}</strong>{}</li>",
            qty,
            escape_html(name),
            if notes.is_empty() {
                String::new()
            } else {
                format!("<br/><small>Note: {}</small>", escape_html(&notes))
            }
        ));
    }
    if items_html.is_empty() {
        items_html.push_str("<li>No items</li>");
    }

    let ticket_html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Kitchen Ticket - {order_id}</title>
<style>
  body {{ margin: 0; padding: 10px; background: #fff; font-family: monospace; font-size: 13px; }}
  h1 {{ margin: 0 0 6px 0; font-size: 18px; }}
  hr {{ border: none; border-top: 1px dashed #000; margin: 8px 0; }}
  ul {{ margin: 0; padding-left: 18px; }}
  li {{ margin: 4px 0; }}
  .meta {{ line-height: 1.35; white-space: pre-wrap; }}
</style>
</head>
<body>
<h1>KITCHEN TICKET</h1>
<div class="meta">
Order: {order_number}
Type: {order_type}
Table: {table_number}
Created: {created_at}
Address: {delivery_address}
Delivery Notes: {delivery_notes}
Order Notes: {special_instructions}
</div>
<hr/>
<ul>{items_html}</ul>
<hr/>
<div>-- End Ticket --</div>
</body>
</html>"#,
        order_id = escape_html(order_id),
        order_number = escape_html(&order_number),
        order_type = escape_html(&order_type),
        table_number = escape_html(&table_number),
        created_at = escape_html(&created_at),
        delivery_address = escape_html(&delivery_address),
        delivery_notes = escape_html(&delivery_notes),
        special_instructions = escape_html(&special_instructions),
        items_html = items_html,
    );

    let receipts_dir = data_dir.join(RECEIPTS_DIR);
    fs::create_dir_all(&receipts_dir).map_err(|e| format!("create receipts dir: {e}"))?;
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    let filename = format!("kitchen_ticket_{order_id}_{timestamp}.html");
    let file_path = receipts_dir.join(&filename);
    fs::write(&file_path, ticket_html).map_err(|e| format!("write kitchen ticket file: {e}"))?;
    let path_str = file_path.to_string_lossy().to_string();
    info!(order_id = %order_id, "Kitchen ticket file generated");
    Ok(path_str)
}

#[allow(dead_code)]
fn generate_shift_checkout_file(
    db: &DbState,
    shift_id: &str,
    data_dir: &Path,
) -> Result<String, String> {
    let layout = resolve_layout_config(db, &serde_json::json!({}), "shift_checkout")?;
    let document = ReceiptDocument::ShiftCheckout(build_shift_checkout_doc(db, shift_id, None)?);
    let html = receipt_renderer::render_html(&document, &layout);
    let path_str = write_print_html_file(data_dir, "shift_checkout", shift_id, &html)?;
    info!(shift_id = %shift_id, "Shift checkout file generated");
    Ok(path_str)
}

// ---------------------------------------------------------------------------
// Hardware dispatch
// ---------------------------------------------------------------------------

use crate::print_dispatch::{
    begin_managed_submission, cancel_managed_submission_before_io, ApplyResult, AttemptIdentity,
    AttemptLease, AttemptObservation, DispatchManager, DispatchState, ParentTransition,
    PrepareManagedAttempt, PrinterTargetKey,
};
use crate::windows_spooler::{
    SpoolerError, SpoolerOperation, SystemWindowsSpooler, WindowsRawRequest, WindowsSpooler,
};

const MANAGED_ENVELOPE_VERSION: u32 = 2;
const MANUAL_RECOVERY_ERROR: &str = "The printer may have accepted this job, but the POS could not confirm the final transport result. Automatic retry is disabled. Check the physical printer or Windows queue before retrying manually.";

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum FrozenTargetEnvelope {
    Windows { queue: String },
    RawTcp { host: String, port: u16 },
    Serial { port_name: String, baud_rate: u32 },
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
struct FrozenDrawerConfig {
    profile_id: String,
    enabled: bool,
    mode: String,
    host: Option<String>,
    port: u16,
}

impl FrozenDrawerConfig {
    fn from_profile(profile: &Value, profile_id: &str) -> Self {
        Self {
            profile_id: profile_id.to_owned(),
            enabled: profile
                .get("openCashDrawer")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            mode: profile
                .get("drawerMode")
                .and_then(Value::as_str)
                .unwrap_or("none")
                .to_owned(),
            host: profile
                .get("drawerHost")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            port: profile
                .get("drawerPort")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .filter(|value| *value != 0)
                .unwrap_or(9100),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.profile_id.trim().is_empty() {
            return Err("Frozen drawer configuration has no profile id".into());
        }
        if !self.enabled {
            return Ok(());
        }
        match self.mode.as_str() {
            "none" => Ok(()),
            "escpos_tcp"
                if self
                    .host
                    .as_deref()
                    .is_some_and(|host| !host.trim().is_empty()) =>
            {
                Ok(())
            }
            "escpos_tcp" => Err("Frozen drawer TCP configuration has no host".into()),
            _ => Err("Frozen drawer configuration has an unsupported mode".into()),
        }
    }
}

impl FrozenTargetEnvelope {
    fn from_resolved(target: &printers::ResolvedPrinterTarget) -> Self {
        match target {
            printers::ResolvedPrinterTarget::WindowsQueue { printer_name } => Self::Windows {
                queue: printer_name.clone(),
            },
            printers::ResolvedPrinterTarget::RawTcp { host, port } => Self::RawTcp {
                host: host.clone(),
                port: *port,
            },
            printers::ResolvedPrinterTarget::SerialPort {
                port_name,
                baud_rate,
            } => Self::Serial {
                port_name: port_name.clone(),
                baud_rate: *baud_rate,
            },
        }
    }

    fn to_resolved(&self) -> Result<printers::ResolvedPrinterTarget, String> {
        let target = match self {
            Self::Windows { queue } if !queue.trim().is_empty() => {
                printers::ResolvedPrinterTarget::WindowsQueue {
                    printer_name: queue.clone(),
                }
            }
            Self::RawTcp { host, port } if !host.trim().is_empty() && *port != 0 => {
                printers::ResolvedPrinterTarget::RawTcp {
                    host: host.clone(),
                    port: *port,
                }
            }
            Self::Serial {
                port_name,
                baud_rate,
            } if !port_name.trim().is_empty() && *baud_rate != 0 => {
                printers::ResolvedPrinterTarget::SerialPort {
                    port_name: port_name.clone(),
                    baud_rate: *baud_rate,
                }
            }
            _ => {
                return Err("Frozen print envelope contains an incomplete transport target".into())
            }
        };
        Ok(target)
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct FrozenRenderEnvelope {
    version: u32,
    renderer_layout_revision: String,
    effective_profile_id: String,
    effective_profile_name: String,
    driver_type: String,
    document_kind: String,
    transport: FrozenTargetEnvelope,
    paper_width_mm: i64,
    printable_width_dots: u16,
    left_margin_dots: u16,
    encoding: String,
    code_page: Option<u8>,
    greek_render_mode: Option<String>,
    command_profile: String,
    emulation: String,
    template: String,
    font_type: String,
    layout_density: String,
    header_emphasis: String,
    layout_density_scale: f32,
    text_scale: f32,
    classic_customer_render_mode: String,
    raster_threshold: u8,
    body_font_weight: u32,
    decimal_comma: bool,
    detected_brand: String,
    language: String,
    organization_name: String,
    store_subtitle: Option<String>,
    store_address: Option<String>,
    store_phone: Option<String>,
    vat_number: Option<String>,
    tax_office: Option<String>,
    footer_text: Option<String>,
    show_qr_code: bool,
    qr_configured: bool,
    copy_label: Option<String>,
    currency_symbol: String,
    cut_paper: bool,
    logo_enabled: bool,
    logo_configured: bool,
    logo_included: bool,
    logo_scale: f32,
    drawer: FrozenDrawerConfig,
    warning_codes: Vec<String>,
}

impl FrozenRenderEnvelope {
    fn validate(
        &self,
        expected_document_kind: &str,
    ) -> Result<printers::ResolvedPrinterTarget, String> {
        if self.version != MANAGED_ENVELOPE_VERSION {
            return Err(format!(
                "Unsupported frozen print envelope version: {}",
                self.version
            ));
        }
        if self.effective_profile_id.trim().is_empty() {
            return Err("Frozen print envelope has no effective printer profile".into());
        }
        if self.renderer_layout_revision.trim().is_empty() {
            return Err("Frozen print envelope has no renderer layout revision".into());
        }
        if self.effective_profile_name.trim().is_empty() {
            return Err("Frozen print envelope has no effective printer profile name".into());
        }
        if !matches!(self.driver_type.as_str(), "windows" | "escpos") {
            return Err("Frozen print envelope has an unsupported driver type".into());
        }
        if self.document_kind != expected_document_kind {
            return Err("Frozen print envelope document kind does not match the parent job".into());
        }
        let physical_width = match self.paper_width_mm {
            58 => 384u16,
            80 => 576u16,
            112 => 832u16,
            _ => return Err("Frozen print envelope has an unsupported paper width".into()),
        };
        if !(64..=physical_width).contains(&self.printable_width_dots) {
            return Err("Frozen print envelope printable width is out of bounds".into());
        }
        if self.left_margin_dots > 200
            || self
                .left_margin_dots
                .saturating_add(self.printable_width_dots)
                > physical_width
        {
            return Err("Frozen print envelope left margin is out of bounds".into());
        }
        if self.encoding.trim().is_empty() || self.encoding.len() > 64 {
            return Err("Frozen print envelope has an invalid character encoding".into());
        }
        if self
            .greek_render_mode
            .as_deref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 64)
        {
            return Err("Frozen print envelope has an invalid Greek render mode".into());
        }
        if !matches!(self.command_profile.as_str(), "full_style" | "safe_text") {
            return Err("Frozen print envelope has an invalid command profile".into());
        }
        if !matches!(
            self.emulation.as_str(),
            "auto" | "escpos" | "starline" | "star_line"
        ) {
            return Err("Frozen print envelope has an invalid emulation mode".into());
        }
        if !matches!(self.template.as_str(), "classic" | "modern") {
            return Err("Frozen print envelope has an invalid receipt template".into());
        }
        if !matches!(self.font_type.as_str(), "a" | "b") {
            return Err("Frozen print envelope has an invalid font type".into());
        }
        if !matches!(
            self.layout_density.as_str(),
            "compact" | "balanced" | "spacious"
        ) {
            return Err("Frozen print envelope has an invalid layout density".into());
        }
        if !matches!(self.header_emphasis.as_str(), "normal" | "strong") {
            return Err("Frozen print envelope has an invalid header emphasis".into());
        }
        if !self.layout_density_scale.is_finite()
            || !(0.7..=1.35).contains(&self.layout_density_scale)
        {
            return Err("Frozen print envelope layout density scale is out of bounds".into());
        }
        if !self.text_scale.is_finite() || !(0.8..=2.0).contains(&self.text_scale) {
            return Err("Frozen print envelope text scale is out of bounds".into());
        }
        if !matches!(
            self.classic_customer_render_mode.as_str(),
            "text" | "raster_exact"
        ) {
            return Err("Frozen print envelope has an invalid classic customer render mode".into());
        }
        if !(40..=240).contains(&self.raster_threshold) {
            return Err("Frozen print envelope raster threshold is out of bounds".into());
        }
        if !(400..=800).contains(&self.body_font_weight) || self.body_font_weight % 100 != 0 {
            return Err("Frozen print envelope body font weight is out of bounds".into());
        }
        if !self.logo_scale.is_finite() || !(0.5..=2.0).contains(&self.logo_scale) {
            return Err("Frozen print envelope logo scale is out of bounds".into());
        }
        if self.detected_brand.trim().is_empty() || self.detected_brand.len() > 64 {
            return Err("Frozen print envelope has an invalid detected printer brand".into());
        }
        if self.organization_name.trim().is_empty() || self.organization_name.len() > 512 {
            return Err("Frozen print envelope has an invalid organization name".into());
        }
        for (label, value) in [
            ("language", Some(self.language.as_str())),
            ("store subtitle", self.store_subtitle.as_deref()),
            ("store address", self.store_address.as_deref()),
            ("store phone", self.store_phone.as_deref()),
            ("VAT number", self.vat_number.as_deref()),
            ("tax office", self.tax_office.as_deref()),
            ("footer text", self.footer_text.as_deref()),
            ("copy label", self.copy_label.as_deref()),
            ("currency symbol", Some(self.currency_symbol.as_str())),
        ] {
            if value.is_some_and(|value| value.len() > 512) {
                return Err(format!("Frozen print envelope {label} is too long"));
            }
        }
        if self.logo_included && (!self.logo_enabled || !self.logo_configured) {
            return Err("Frozen print envelope claims an unconfigured logo was included".into());
        }
        if self.warning_codes.len() > 64
            || self
                .warning_codes
                .iter()
                .any(|code| code.trim().is_empty() || code.len() > 128)
        {
            return Err("Frozen print envelope has invalid warning codes".into());
        }
        self.drawer.validate()?;
        self.transport.to_resolved()
    }
}

pub(crate) trait ManagedRawTransport: Send + Sync {
    fn send(
        &self,
        db: &DbState,
        target: &printers::ResolvedPrinterTarget,
        bytes: &[u8],
        document_name: &str,
        cancel: &AtomicBool,
    ) -> Result<printers::RawPrintResult, printers::RawTransportFailure>;
}

trait ManagedDrawerTransport: Send + Sync {
    fn kick(&self, db: &DbState, config: &FrozenDrawerConfig) -> Result<(), String>;
}

#[derive(Clone, Copy)]
struct SystemManagedDrawerTransport;

impl ManagedDrawerTransport for SystemManagedDrawerTransport {
    fn kick(&self, db: &DbState, config: &FrozenDrawerConfig) -> Result<(), String> {
        let frozen_profile = serde_json::json!({
            "id": config.profile_id,
            "openCashDrawer": config.enabled,
            "drawerMode": config.mode,
            "drawerHost": config.host,
            "drawerPort": config.port,
        });
        drawer::try_drawer_kick_after_print(db, &frozen_profile)
    }
}

struct SystemManagedRawTransport;

impl ManagedRawTransport for SystemManagedRawTransport {
    fn send(
        &self,
        _db: &DbState,
        target: &printers::ResolvedPrinterTarget,
        bytes: &[u8],
        document_name: &str,
        cancel: &AtomicBool,
    ) -> Result<printers::RawPrintResult, printers::RawTransportFailure> {
        printers::print_raw_for_target_cancellable_with_evidence(
            target,
            bytes,
            document_name,
            cancel,
        )
    }
}

struct FrozenManagedAttempt {
    lease: AttemptLease,
    active: ActivePrintGuard,
    identity: AttemptIdentity,
    printer_profile_id: String,
    target: printers::ResolvedPrinterTarget,
    bytes: Arc<[u8]>,
    document_name: String,
    output_path: String,
    drawer: FrozenDrawerConfig,
    warning_codes: Vec<String>,
}

fn persist_managed_post_success_warnings(
    db: &DbState,
    job_id: &str,
    render_warning_codes: &[String],
    drawer_error: Option<&str>,
) {
    if render_warning_codes.is_empty() && drawer_error.is_none() {
        return;
    }
    let render_message = (!render_warning_codes.is_empty())
        .then(|| format!("Render warnings: {}", render_warning_codes.join(", ")));
    let drawer_message = drawer_error.map(|error| format!("Drawer kick failed: {error}"));
    let message = [render_message, drawer_message]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" | ");
    let code = if drawer_error.is_some() {
        "drawer_kick_failed"
    } else {
        "render_warning"
    };
    let _ = set_print_job_warning(db, job_id, code, &message);
}

fn run_managed_post_success(
    db: &DbState,
    drawer: &dyn ManagedDrawerTransport,
    attempt: &FrozenManagedAttempt,
) {
    let drawer_error = attempt
        .drawer
        .enabled
        .then(|| drawer.kick(db, &attempt.drawer).err())
        .flatten();
    persist_managed_post_success_warnings(
        db,
        &attempt.identity.local_job_id,
        &attempt.warning_codes,
        drawer_error.as_deref(),
    );
}

fn dispatch_target_key(target: &printers::ResolvedPrinterTarget) -> PrinterTargetKey {
    match target {
        printers::ResolvedPrinterTarget::WindowsQueue { printer_name } => {
            PrinterTargetKey::WindowsQueue(printer_name.clone())
        }
        printers::ResolvedPrinterTarget::RawTcp { host, port } => PrinterTargetKey::RawTcp {
            host: host.clone(),
            port: *port,
        },
        printers::ResolvedPrinterTarget::SerialPort {
            port_name,
            baud_rate,
        } => PrinterTargetKey::Serial {
            port_name: port_name.clone(),
            baud_rate: *baud_rate,
        },
    }
}

fn configured_logo_source(layout: &LayoutConfig) -> bool {
    layout
        .logo_url
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn frozen_paper_width_mm(paper_width: crate::escpos::PaperWidth) -> i64 {
    match paper_width {
        crate::escpos::PaperWidth::Mm58 => 58,
        crate::escpos::PaperWidth::Mm80 => 80,
        crate::escpos::PaperWidth::Mm112 => 112,
    }
}

fn frozen_enum_name(value: impl serde::Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .expect("receipt layout enums serialize as strings")
}

fn render_managed_payload(
    db: &DbState,
    entity_type: &str,
    profile: &Value,
    document: &ReceiptDocument,
) -> Result<
    (
        Vec<u8>,
        LayoutConfig,
        Vec<receipt_renderer::RenderWarning>,
        bool,
    ),
    String,
> {
    let layout = resolve_layout_config(db, profile, entity_type)?;
    let mut rendered = receipt_renderer::render_escpos(document, &layout);
    let embed_logo_in_body = rendered.body_mode == receipt_renderer::EscPosBodyMode::RasterExact
        && is_receipt_like_entity_type(entity_type);
    let mut logo_included = embed_logo_in_body
        && layout.show_logo
        && configured_logo_source(&layout)
        && !rendered
            .warnings
            .iter()
            .any(|warning| warning.code == "logo_text_fallback");
    if !embed_logo_in_body {
        match build_logo_prefix_for_layout(&layout) {
            Ok(Some(prefix)) if !prefix.is_empty() => {
                let mut combined = Vec::with_capacity(rendered.bytes.len() + prefix.len() + 1);
                combined.extend_from_slice(&prefix);
                if rendered.body_mode != receipt_renderer::EscPosBodyMode::RasterExact {
                    combined.push(0x0A);
                }
                combined.extend_from_slice(&rendered.bytes);
                rendered.bytes = combined;
                logo_included = true;
            }
            Ok(Some(_)) => rendered.warnings.push(receipt_renderer::RenderWarning {
                code: "logo_text_fallback".into(),
                message: "Logo rendering returned no raster bytes; using text header fallback"
                    .into(),
            }),
            Ok(None) => {}
            Err(error) => rendered.warnings.push(receipt_renderer::RenderWarning {
                code: "logo_text_fallback".into(),
                message: format!("Logo rendering failed; using text header fallback ({error})"),
            }),
        }
    }
    if !profile
        .get("cutPaper")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        let len = rendered.bytes.len();
        if len >= 4 && rendered.bytes[len - 4..] == [0x1D, 0x56, 0x41, 0x10] {
            rendered.bytes.truncate(len - 4);
        } else if len >= 3 && rendered.bytes[len - 3..] == [0x1B, 0x64, 0x01] {
            rendered.bytes.truncate(len - 3);
        }
    }
    Ok((rendered.bytes, layout, rendered.warnings, logo_included))
}

fn decode_frozen_print_snapshot(
    version: i64,
    compressed: &[u8],
    sha256: &str,
    envelope: &str,
    document_kind: &str,
) -> Result<(Vec<u8>, FrozenRenderEnvelope), String> {
    let bytes = crate::print_snapshot::decode_print_payload(version, compressed, sha256)?;
    let parsed: FrozenRenderEnvelope = serde_json::from_str(envelope)
        .map_err(|error| format!("Frozen print envelope is corrupt: {error}"))?;
    parsed.validate(document_kind)?;
    Ok((bytes, parsed))
}

fn load_frozen_job(
    conn: &rusqlite::Connection,
    job_id: &str,
    document_kind: &str,
) -> Result<Option<(Vec<u8>, FrozenRenderEnvelope, String)>, String> {
    let columns = conn
        .query_row(
            "SELECT document_snapshot_version, document_snapshot_zlib,
                    document_snapshot_sha256, render_profile_snapshot_json,
                    COALESCE(output_path, '')
             FROM print_jobs WHERE id = ?1",
            [job_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<Vec<u8>>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(|error| format!("Read frozen print job: {error}"))?;
    match columns {
        (None, None, None, None, _) => Ok(None),
        (Some(version), Some(compressed), Some(sha256), Some(envelope), output_path) => {
            let (bytes, parsed) = decode_frozen_print_snapshot(
                version,
                &compressed,
                &sha256,
                &envelope,
                document_kind,
            )?;
            Ok(Some((bytes, parsed, output_path)))
        }
        _ => Err("Frozen print snapshot/envelope is incomplete".into()),
    }
}

/// Validate immutable frozen fields already read by the history snapshot.
/// Keeping this pure lets queue polling cache only this expensive decode/hash
/// while status, expiry and transport blockers remain live database reads.
pub(crate) fn validate_frozen_print_snapshot_for_history(
    version: i64,
    compressed: &[u8],
    sha256: &str,
    envelope: &str,
    document_kind: &str,
) -> Result<(), String> {
    decode_frozen_print_snapshot(version, compressed, sha256, envelope, document_kind).map(|_| ())
}

fn mark_managed_preparation_failed(db: &DbState, job_id: &str, error: &str) {
    let conn = lock_conn_recovering(db);
    let now = Utc::now().to_rfc3339();
    let _ = conn.execute(
        "UPDATE print_jobs
         SET status = 'failed', retry_count = retry_count + 1,
             last_error = ?1, next_retry_at = NULL,
             last_attempt_at = ?2, completed_at = ?2,
             history_expires_at = datetime(?2, '+30 days'),
             updated_at = ?2
         WHERE id = ?3 AND status IN ('pending', 'printing')",
        params![error, now, job_id],
    );
}

#[derive(Debug, Eq, PartialEq)]
enum ManagedPreparationFailure {
    Fatal(String),
    ClaimLostCleanup(String),
}

impl ManagedPreparationFailure {
    fn message(&self) -> &str {
        match self {
            Self::Fatal(message) | Self::ClaimLostCleanup(message) => message,
        }
    }

    #[cfg(test)]
    fn contains(&self, needle: &str) -> bool {
        self.message().contains(needle)
    }
}

impl std::fmt::Display for ManagedPreparationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl From<String> for ManagedPreparationFailure {
    fn from(message: String) -> Self {
        Self::Fatal(message)
    }
}

impl From<&str> for ManagedPreparationFailure {
    fn from(message: &str) -> Self {
        Self::Fatal(message.to_owned())
    }
}

impl From<ManagedPreparationFailure> for String {
    fn from(error: ManagedPreparationFailure) -> Self {
        error.to_string()
    }
}

fn handle_managed_preparation_failure(
    db: &DbState,
    job_id: &str,
    error: &ManagedPreparationFailure,
) {
    match error {
        ManagedPreparationFailure::ClaimLostCleanup(message) => {
            error!(
                job_id = %job_id,
                error = %message,
                "Managed print claim-loser cleanup failed; winner parent left unchanged"
            );
        }
        ManagedPreparationFailure::Fatal(message) => {
            warn!(job_id = %job_id, error = %message, "Managed print preparation failed before transport");
            mark_managed_preparation_failed(db, job_id, message);
        }
    }
}

fn prepare_frozen_attempt(
    db: &DbState,
    data_dir: &Path,
    manager: &DispatchManager,
    job_id: &str,
    entity_type: &str,
    entity_id: &str,
    payload_json: Option<&str>,
    requested_profile_id: Option<&str>,
) -> Result<Option<FrozenManagedAttempt>, ManagedPreparationFailure> {
    prepare_frozen_attempt_with_profile_hooks(
        db,
        data_dir,
        manager,
        job_id,
        entity_type,
        entity_id,
        payload_json,
        requested_profile_id,
        &|_| {},
        &|_| {},
    )
}

fn prepare_frozen_attempt_with_profile_hooks(
    db: &DbState,
    data_dir: &Path,
    manager: &DispatchManager,
    job_id: &str,
    entity_type: &str,
    entity_id: &str,
    payload_json: Option<&str>,
    requested_profile_id: Option<&str>,
    before_profile_association_hook: &dyn Fn(&str),
    profile_resolved_hook: &dyn Fn(&str),
) -> Result<Option<FrozenManagedAttempt>, ManagedPreparationFailure> {
    prepare_frozen_attempt_with_hooks(
        db,
        data_dir,
        manager,
        job_id,
        entity_type,
        entity_id,
        payload_json,
        requested_profile_id,
        before_profile_association_hook,
        profile_resolved_hook,
        &|_: &Path| {},
    )
}

fn prepare_frozen_attempt_with_hooks(
    db: &DbState,
    data_dir: &Path,
    manager: &DispatchManager,
    job_id: &str,
    entity_type: &str,
    entity_id: &str,
    payload_json: Option<&str>,
    requested_profile_id: Option<&str>,
    before_profile_association_hook: &dyn Fn(&str),
    profile_resolved_hook: &dyn Fn(&str),
    provisional_artifact_hook: &dyn Fn(&Path),
) -> Result<Option<FrozenManagedAttempt>, ManagedPreparationFailure> {
    if Uuid::parse_str(job_id)
        .ok()
        .filter(|parsed| parsed.hyphenated().to_string() == job_id)
        .is_none()
    {
        return Err("Legacy print job id is not a canonical UUID; managed dispatch requires a POS-owned marker and no transport was attempted".into());
    }

    let stored = {
        let conn = lock_conn_recovering(db);
        load_frozen_job(&conn, job_id, entity_type)?
    };

    let (bytes, envelope, target, output_path, pending_html, active) =
        if let Some((bytes, envelope, output_path)) = stored {
            let active =
                ActivePrintGuard::register(db, job_id, Some(envelope.effective_profile_id.clone()))
                    .map_err(|error| format!("Register active managed print attempt: {error}"))?;
            profile_resolved_hook(&envelope.effective_profile_id);
            if !active.is_primary() {
                return Ok(None);
            }
            let target = envelope.validate(entity_type)?;
            (bytes, envelope, target, output_path, None, active)
        } else {
            let role = if entity_type == "kitchen_ticket" {
                "kitchen"
            } else {
                "receipt"
            };
            // Validate and freeze the source document before resolving hardware.
            // Missing source entities are permanent preparation failures and should
            // retain their actionable "not found" error even on an unconfigured POS.
            let document = build_document_for_job(db, entity_type, entity_id, payload_json)?;
            sanitize_path_segment("entity_type", entity_type)?;
            sanitize_path_segment("entity_id", entity_id)?;
            let profile_association_guard = profile_association_coordination()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let profile =
                printers::resolve_printer_profile_for_role(db, requested_profile_id, Some(role))?
                    .ok_or_else(|| {
                    format!("No hardware printer profile resolved for entity type {entity_type}")
                })?;
            if !profile
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
            {
                return Err("Resolved printer profile is disabled".into());
            }
            let profile_id = profile
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("Resolved printer profile has no stable id")?
                .to_owned();
            before_profile_association_hook(&profile_id);
            let active = ActivePrintGuard::register(db, job_id, Some(profile_id.clone()))
                .map_err(|error| format!("Register active managed print attempt: {error}"))?;
            drop(profile_association_guard);
            profile_resolved_hook(&profile_id);
            if !active.is_primary() {
                return Ok(None);
            }
            let target = printers::resolve_printer_target(&profile)?;
            let (bytes, layout, warnings, logo_included) =
                render_managed_payload(db, entity_type, &profile, &document)?;
            let warning_codes = warnings.into_iter().map(|warning| warning.code).collect();
            let drawer = FrozenDrawerConfig::from_profile(&profile, &profile_id);
            let envelope = FrozenRenderEnvelope {
                version: MANAGED_ENVELOPE_VERSION,
                renderer_layout_revision: receipt_renderer::layout_revision().to_owned(),
                effective_profile_id: profile_id,
                effective_profile_name: profile
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                driver_type: profile
                    .get("driverType")
                    .and_then(Value::as_str)
                    .unwrap_or("windows")
                    .to_owned(),
                document_kind: entity_type.to_owned(),
                transport: FrozenTargetEnvelope::from_resolved(&target),
                paper_width_mm: frozen_paper_width_mm(layout.paper_width),
                printable_width_dots: layout.printable_width_dots,
                left_margin_dots: layout.left_margin_dots,
                encoding: layout.character_set.clone(),
                code_page: layout.escpos_code_page,
                greek_render_mode: layout.greek_render_mode.clone(),
                command_profile: frozen_enum_name(layout.command_profile),
                emulation: frozen_enum_name(layout.emulation_mode),
                template: frozen_enum_name(layout.template),
                font_type: frozen_enum_name(layout.font_type),
                layout_density: frozen_enum_name(layout.layout_density),
                header_emphasis: frozen_enum_name(layout.header_emphasis),
                layout_density_scale: layout.layout_density_scale,
                text_scale: layout.text_scale,
                classic_customer_render_mode: frozen_enum_name(layout.classic_customer_render_mode),
                raster_threshold: layout.raster_threshold,
                body_font_weight: layout.body_font_weight,
                decimal_comma: layout.decimal_comma,
                detected_brand: layout.detected_brand.label().to_ascii_lowercase(),
                language: layout.language.clone(),
                organization_name: layout.organization_name.clone(),
                store_subtitle: layout.store_subtitle.clone(),
                store_address: layout.store_address.clone(),
                store_phone: layout.store_phone.clone(),
                vat_number: layout.vat_number.clone(),
                tax_office: layout.tax_office.clone(),
                footer_text: layout.footer_text.clone(),
                show_qr_code: layout.show_qr_code,
                qr_configured: layout
                    .qr_data
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty()),
                copy_label: layout.copy_label.clone(),
                currency_symbol: layout.currency_symbol.clone(),
                cut_paper: profile
                    .get("cutPaper")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                logo_enabled: layout.show_logo,
                logo_configured: configured_logo_source(&layout),
                logo_included,
                logo_scale: layout.logo_scale,
                drawer,
                warning_codes,
            };
            envelope.validate(entity_type)?;
            let html = receipt_renderer::render_html(&document, &layout);
            (bytes, envelope, target, String::new(), Some(html), active)
        };

    let profile_id = envelope.effective_profile_id.clone();
    let drawer = envelope.drawer.clone();
    let warning_codes = envelope.warning_codes.clone();
    let envelope_json = serde_json::to_string(&envelope)
        .map_err(|error| format!("Serialize frozen print envelope: {error}"))?;
    if active.cancel_requested() {
        return Ok(None);
    }
    {
        let conn = lock_conn_recovering(db);
        if is_print_queue_paused_with_conn(&conn, Some(&profile_id)) {
            return Ok(None);
        }
    }

    let target_key = dispatch_target_key(&target);
    let mut lease = match manager.claim(target_key.clone()) {
        Ok(lease) => lease,
        Err(
            crate::print_dispatch::DispatchError::LaneBusy
            | crate::print_dispatch::DispatchError::CircuitOpen,
        ) => return Ok(None),
        Err(error) => return Err(format!("Claim managed printer lane: {error}").into()),
    };
    let mut provisional_artifact = match pending_html.as_deref() {
        Some(html) => {
            match ProvisionalPrintArtifact::create(data_dir, entity_type, entity_id, html) {
                Ok(artifact) => Some(artifact),
                Err(error) => {
                    lease.release_unstarted();
                    return Err(error.into());
                }
            }
        }
        None => None,
    };
    if let Some(artifact) = provisional_artifact.as_ref() {
        provisional_artifact_hook(&artifact.path);
    }
    let identity = {
        let conn = lock_conn_recovering(db);
        match crate::print_dispatch::prepare_managed_attempt(
            &conn,
            PrepareManagedAttempt {
                local_job_id: job_id.to_owned(),
                printer_profile_id: profile_id.clone(),
                target: target_key,
                document_kind: entity_type.to_owned(),
                payload: bytes.clone(),
                render_profile_snapshot_json: envelope_json,
                now: Utc::now(),
            },
        ) {
            Ok(identity) => identity,
            Err(crate::print_dispatch::DispatchError::QueuePaused) => {
                lease.release_unstarted();
                rollback_provisional_artifact(
                    &mut provisional_artifact,
                    "Clean provisional artifact after atomic queue-pause rejection",
                )?;
                return Ok(None);
            }
            Err(crate::print_dispatch::DispatchError::ParentNotEligible) => {
                lease.release_unstarted();
                if let Err(cleanup_error) = rollback_provisional_artifact(
                    &mut provisional_artifact,
                    "Clean provisional artifact after ineligible-parent contention",
                ) {
                    return Err(ManagedPreparationFailure::ClaimLostCleanup(cleanup_error));
                }
                return Ok(None);
            }
            Err(error) => {
                lease.release_unstarted();
                let preparation_error = format!("Prepare managed print attempt: {error}");
                if let Err(cleanup_error) = rollback_provisional_artifact(
                    &mut provisional_artifact,
                    "Clean provisional artifact after preparation failure",
                ) {
                    return Err(format!("{preparation_error}; {cleanup_error}").into());
                }
                return Err(preparation_error.into());
            }
        }
    };
    let output_path = provisional_artifact
        .take()
        .map(ProvisionalPrintArtifact::commit)
        .unwrap_or(output_path);
    let document_name = {
        let conn = lock_conn_recovering(db);
        crate::print_dispatch::read_attempt(&conn, identity.attempt_id)
            .map_err(|error| format!("Read managed print attempt: {error}"))?
            .ok_or("Managed print attempt disappeared")?
            .document_name
    };

    Ok(Some(FrozenManagedAttempt {
        lease,
        active,
        identity,
        printer_profile_id: profile_id,
        target,
        bytes: Arc::from(bytes),
        document_name,
        output_path,
        drawer,
        warning_codes,
    }))
}

fn execute_raw_attempt(
    db: &DbState,
    manager: &DispatchManager,
    raw: &dyn ManagedRawTransport,
    drawer: &dyn ManagedDrawerTransport,
    mut attempt: FrozenManagedAttempt,
) -> Result<(), String> {
    debug_assert!(!attempt.printer_profile_id.is_empty());
    let cancel = attempt.active.cancel_token();
    if begin_managed_submission(
        &lock_conn_recovering(db),
        attempt.identity.attempt_id,
        Utc::now(),
    )
    .map_err(|error| format!("Start managed raw attempt: {error}"))?
        != ApplyResult::Applied
    {
        attempt.lease.release_unstarted();
        return Ok(());
    }
    if cancel.load(Ordering::Acquire) {
        if cancel_managed_submission_before_io(
            &lock_conn_recovering(db),
            attempt.identity.attempt_id,
            Utc::now(),
        )
        .map_err(|error| format!("Cancel managed raw attempt before I/O: {error}"))?
            == ApplyResult::Applied
        {
            attempt.lease.release_unstarted();
        }
        return Ok(());
    }
    let result = raw.send(
        db,
        &attempt.target,
        &attempt.bytes,
        &attempt.document_name,
        &cancel,
    );
    let (state, parent, observation) = match result {
        Ok(result) => (
            DispatchState::Sent,
            ParentTransition::Dispatched {
                output_path: attempt.output_path.clone(),
            },
            AttemptObservation {
                now: Utc::now(),
                bytes_written: Some(i64::try_from(result.bytes_written).unwrap_or(i64::MAX)),
                ..AttemptObservation::default()
            },
        ),
        Err(failure) if failure.kind == printers::RawTransportFailureKind::DefinitelyNotSent => (
            DispatchState::TransportError,
            ParentTransition::RetryableFailure {
                error: failure.message.clone(),
            },
            AttemptObservation {
                now: Utc::now(),
                bytes_written: Some(i64::try_from(failure.bytes_written).unwrap_or(0)),
                last_error: Some(failure.message),
                ..AttemptObservation::default()
            },
        ),
        Err(failure) => (
            DispatchState::Unknown,
            ParentTransition::ManualFailure {
                error: MANUAL_RECOVERY_ERROR.into(),
            },
            AttemptObservation {
                now: Utc::now(),
                bytes_written: Some(i64::try_from(failure.bytes_written).unwrap_or(i64::MAX)),
                last_error: Some(format!("{} {MANUAL_RECOVERY_ERROR}", failure.message)),
                ..AttemptObservation::default()
            },
        ),
    };
    let applied = manager
        .finalize_attempt_and_parent(
            &lock_conn_recovering(db),
            &mut attempt.lease,
            attempt.identity.attempt_id,
            state,
            parent,
            observation,
        )
        .map_err(|error| format!("Finalize managed raw attempt: {error}"))?;
    if state == DispatchState::Sent && applied == ApplyResult::Applied {
        run_managed_post_success(db, drawer, &attempt);
    }
    Ok(())
}

fn execute_windows_attempt(
    db: &DbState,
    manager: &DispatchManager,
    spooler: Arc<dyn WindowsSpooler>,
    drawer: &dyn ManagedDrawerTransport,
    timeout: Duration,
    mut attempt: FrozenManagedAttempt,
) -> Result<(), String> {
    let printers::ResolvedPrinterTarget::WindowsQueue { printer_name } = &attempt.target else {
        return Err("Windows executor received a non-Windows target".into());
    };
    debug_assert!(!attempt.printer_profile_id.is_empty());
    let cancel = attempt.active.cancel_token();
    if begin_managed_submission(
        &lock_conn_recovering(db),
        attempt.identity.attempt_id,
        Utc::now(),
    )
    .map_err(|error| format!("Start managed Windows attempt: {error}"))?
        != ApplyResult::Applied
    {
        attempt.lease.release_unstarted();
        return Ok(());
    }
    if cancel.load(Ordering::Acquire) {
        if cancel_managed_submission_before_io(
            &lock_conn_recovering(db),
            attempt.identity.attempt_id,
            Utc::now(),
        )
        .map_err(|error| format!("Cancel managed Windows attempt before I/O: {error}"))?
            == ApplyResult::Applied
        {
            attempt.lease.release_unstarted();
        }
        return Ok(());
    }
    let started = Arc::new(AtomicBool::new(false));
    let callback_started = Arc::clone(&started);
    let callback_db_path = db.db_path.clone();
    let request = WindowsRawRequest {
        printer_name: printer_name.clone(),
        document_name: attempt.document_name.clone(),
        bytes: Arc::clone(&attempt.bytes),
    };
    let attempt_id = attempt.identity.attempt_id;
    let transport_cancel = Arc::clone(&cancel);
    let dispatch = run_dispatch_with_timeout(timeout, Arc::clone(&cancel), move || {
        spooler.submit_raw(request, &transport_cancel, &mut |spool_started| {
            let callback_conn = rusqlite::Connection::open(&callback_db_path).map_err(|_| {
                SpoolerError::Operation {
                    operation: SpoolerOperation::SubmitRaw,
                    code: None,
                }
            })?;
            callback_conn
                .busy_timeout(Duration::from_secs(5))
                .map_err(|_| SpoolerError::Operation {
                    operation: SpoolerOperation::SubmitRaw,
                    code: None,
                })?;
            match crate::print_dispatch::persist_spool_started(
                &callback_conn,
                attempt_id,
                spool_started,
            )
            .map_err(|_| SpoolerError::Operation {
                operation: SpoolerOperation::SubmitRaw,
                code: None,
            })? {
                ApplyResult::Applied => {
                    callback_started.store(true, Ordering::Release);
                    Ok(())
                }
                ApplyResult::NotApplied => Err(SpoolerError::Operation {
                    operation: SpoolerOperation::SubmitRaw,
                    code: None,
                }),
            }
        })
    });

    match dispatch {
        Ok(Ok(_submission)) => {
            let result = manager
                .accept_windows_handoff(
                    &lock_conn_recovering(db),
                    &attempt.lease,
                    attempt.identity.attempt_id,
                    &attempt.output_path,
                    Utc::now(),
                )
                .map_err(|error| format!("Finalize Windows acceptance: {error}"))?;
            if result == ApplyResult::NotApplied {
                warn!(job_id = %attempt.identity.local_job_id, attempt_id = %attempt.identity.attempt_id, "Late Windows acceptance was ignored");
            } else {
                run_managed_post_success(db, drawer, &attempt);
            }
        }
        Ok(Err(error))
            if !started.load(Ordering::Acquire)
                && !matches!(&error, SpoolerError::AfterStart { .. }) =>
        {
            let message = error.to_string();
            let _ = manager
                .finalize_attempt_and_parent(
                    &lock_conn_recovering(db),
                    &mut attempt.lease,
                    attempt.identity.attempt_id,
                    DispatchState::SpoolError,
                    ParentTransition::RetryableFailure {
                        error: message.clone(),
                    },
                    AttemptObservation {
                        now: Utc::now(),
                        last_error: Some(message),
                        ..AttemptObservation::default()
                    },
                )
                .map_err(|error| format!("Finalize Windows pre-start failure: {error}"))?;
        }
        Ok(Err(error)) => {
            let _ = manager
                .finalize_attempt_and_parent(
                    &lock_conn_recovering(db),
                    &mut attempt.lease,
                    attempt.identity.attempt_id,
                    DispatchState::Unknown,
                    ParentTransition::ManualFailure {
                        error: MANUAL_RECOVERY_ERROR.into(),
                    },
                    AttemptObservation {
                        now: Utc::now(),
                        last_error: Some(format!("{error}. {MANUAL_RECOVERY_ERROR}")),
                        ..AttemptObservation::default()
                    },
                )
                .map_err(|error| format!("Finalize ambiguous Windows failure: {error}"))?;
        }
        Err(timeout_error) => {
            let _ = manager
                .finalize_attempt_and_parent(
                    &lock_conn_recovering(db),
                    &mut attempt.lease,
                    attempt.identity.attempt_id,
                    DispatchState::Unknown,
                    ParentTransition::ManualFailure {
                        error: MANUAL_RECOVERY_ERROR.into(),
                    },
                    AttemptObservation {
                        now: Utc::now(),
                        last_error: Some(format!("{timeout_error}. {MANUAL_RECOVERY_ERROR}")),
                        ..AttemptObservation::default()
                    },
                )
                .map_err(|error| format!("Finalize Windows timeout: {error}"))?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct PrintProcessOutcome {
    processed: usize,
    changed: bool,
}

fn process_pending_jobs_with_adapters_outcome(
    db: &DbState,
    data_dir: &Path,
    manager: &DispatchManager,
    raw: &dyn ManagedRawTransport,
    spooler: Arc<dyn WindowsSpooler>,
    windows_timeout: Duration,
) -> Result<PrintProcessOutcome, String> {
    // Recovery is independent of submission pause. A paused queue must still
    // observe exact POS-owned Windows jobs so confirmed cancellations and
    // completed spools can release their retained target lanes.
    let reconciliation =
        reconcile_windows_attempts_bounded(db, manager, Arc::clone(&spooler), windows_timeout)?;
    let conn = lock_conn_recovering(db);

    // Liberate lanes the durable state no longer justifies, BEFORE the pause
    // check — for the same reason reconciliation runs first: a paused queue must
    // still release lanes, or unpausing prints nothing.
    //
    // AttemptLease::drop parks an unreleased lane as Retained, and the only
    // path that clears one is Windows-only. A raw_tcp lane that lands there is
    // unreachable for the life of the process: claim() answers LaneBusy forever,
    // prepare_frozen_attempt turns that into Ok(None), and jobs pile up pending
    // with no attempt row and no error. A till printed nothing for fifteen hours
    // that way after one operator cancel; only a restart cleared it. Never fatal
    // to the tick: if the sweep itself fails, dispatch still tries.
    match manager.sweep_orphaned_lanes(&conn, Utc::now()) {
        Ok(released) if !released.is_empty() => {
            warn!(
                released = released.len(),
                targets = ?released,
                "Released print lanes that no durable blocker justified"
            );
        }
        Ok(_) => {}
        Err(error) => {
            warn!(error = %error, "Print lane sweep failed; dispatch continues");
        }
    }

    if is_print_queue_paused_with_conn(&conn, None) {
        return Ok(PrintProcessOutcome {
            processed: 0,
            changed: reconciliation.observed > 0 || reconciliation.failed > 0,
        });
    }
    let paused_profiles = paused_printer_profiles(&conn);
    let jobs = select_ready_pending_jobs(&conn, &Utc::now().to_rfc3339(), &paused_profiles, 10)?;
    drop(conn);

    let selected = jobs.len();
    let mut deferred = 0usize;
    let mut prepared = Vec::new();
    for (job_id, entity_type, entity_id, payload_json, profile_id) in jobs {
        match prepare_frozen_attempt(
            db,
            data_dir,
            manager,
            &job_id,
            &entity_type,
            &entity_id,
            payload_json.as_deref(),
            profile_id.as_deref(),
        ) {
            Ok(Some(attempt)) => prepared.push(attempt),
            // A deferral is not nothing. This arm used to be empty, and that is
            // how a wedged lane stayed invisible: seven distinct decisions
            // (cancel requested, profile paused, LaneBusy, CircuitOpen, guard
            // not primary, queue paused, parent not eligible) all landed here
            // and left no attempt row, no last_error and no log — so a till
            // that printed nothing for fifteen hours looked healthy from every
            // angle. Leave a trail even when there is nothing to record durably.
            Ok(None) => {
                deferred += 1;
                warn!(
                    job_id = %job_id,
                    entity_type = %entity_type,
                    "Print job deferred without an attempt"
                );
            }
            Err(error) => {
                handle_managed_preparation_failure(db, &job_id, &error);
            }
        }
    }

    std::thread::scope(|scope| {
        let mut workers = Vec::with_capacity(prepared.len());
        let drawer = SystemManagedDrawerTransport;
        for attempt in prepared {
            let worker_spooler = Arc::clone(&spooler);
            workers.push(scope.spawn(move || match attempt.target {
                printers::ResolvedPrinterTarget::WindowsQueue { .. } => execute_windows_attempt(
                    db,
                    manager,
                    worker_spooler,
                    &drawer,
                    windows_timeout,
                    attempt,
                ),
                _ => execute_raw_attempt(db, manager, raw, &drawer, attempt),
            }));
        }
        for worker in workers {
            match worker.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => warn!(error = %error, "Managed print attempt failed"),
                Err(_) => error!("Managed print attempt panicked"),
            }
        }
    });
    // Watchdog signal: work was waiting and not one job reached a transport.
    // `processed` counts jobs SELECTED, not attempted, so on its own it reports
    // a wedged dispatcher as a healthy one — that is why nothing ever alerted
    // while a till sat silent for fifteen hours.
    if selected > 0 && deferred == selected {
        error!(
            selected = selected,
            "Print dispatch attempted nothing: every ready job was deferred"
        );
    }
    Ok(PrintProcessOutcome {
        processed: selected,
        changed: reconciliation.observed > 0 || reconciliation.failed > 0 || selected > 0,
    })
}

#[cfg(test)]
struct NoopWizardWindowsSpooler;

#[cfg(test)]
impl crate::windows_spooler::WindowsSpooler for NoopWizardWindowsSpooler {
    fn submit_raw(
        &self,
        _request: crate::windows_spooler::WindowsRawRequest,
        _cancel: &AtomicBool,
        _on_started: &mut dyn FnMut(
            &crate::windows_spooler::SpoolStarted,
        ) -> Result<(), crate::windows_spooler::SpoolerError>,
    ) -> Result<crate::windows_spooler::SpoolSubmission, crate::windows_spooler::SpoolerError> {
        panic!("wizard raw-target test must never submit to the native spooler")
    }

    fn get_job(
        &self,
        _printer_name: &str,
        _job_id: crate::windows_spooler::WindowsJobId,
    ) -> Result<
        Option<crate::windows_spooler::SpoolJobSnapshot>,
        crate::windows_spooler::SpoolerError,
    > {
        Ok(None)
    }

    fn enum_jobs(
        &self,
        _printer_name: &str,
    ) -> Result<Vec<crate::windows_spooler::SpoolJobSnapshot>, crate::windows_spooler::SpoolerError>
    {
        Ok(Vec::new())
    }

    fn control_job(
        &self,
        _printer_name: &str,
        _job_id: crate::windows_spooler::WindowsJobId,
        _control: crate::windows_spooler::SpoolJobControl,
    ) -> Result<(), crate::windows_spooler::SpoolerError> {
        panic!("wizard raw-target test must never control the native spooler")
    }
}

/// Hardware-free proof seam for pre-rendered wizard samples. It uses the real
/// managed worker and a caller-provided raw adapter, with a native spooler that
/// cannot submit or control hardware.
#[cfg(test)]
pub(crate) fn process_pre_rendered_test_print_with_transport(
    db: &DbState,
    data_dir: &Path,
    raw: &dyn ManagedRawTransport,
) -> Result<usize, String> {
    let manager = {
        let conn = lock_conn_recovering(db);
        DispatchManager::hydrate(&conn)
            .map_err(|error| format!("Hydrate wizard print lanes: {error}"))?
    };
    process_pending_jobs_with_adapters_outcome(
        db,
        data_dir,
        &manager,
        raw,
        Arc::new(NoopWizardWindowsSpooler),
        Duration::from_millis(50),
    )
    .map(|outcome| outcome.processed)
}

#[cfg(test)]
fn process_pending_jobs_with_adapters(
    db: &DbState,
    data_dir: &Path,
    manager: &DispatchManager,
    raw: &dyn ManagedRawTransport,
    spooler: Arc<dyn WindowsSpooler>,
    windows_timeout: Duration,
) -> Result<usize, String> {
    process_pending_jobs_with_adapters_outcome(db, data_dir, manager, raw, spooler, windows_timeout)
        .map(|outcome| outcome.processed)
}

// ---------------------------------------------------------------------------
// Background print worker
// ---------------------------------------------------------------------------

/// Recover stale `printing` jobs that were left behind by a crash or error.
///
/// Any job in `printing` status for more than 30 seconds has an unknown
/// physical state: the printer may already have received raw bytes even if the
/// app never reached the success marker. Fail closed by moving it to `failed`
/// and requiring a manual retry instead of automatically sending the same raw
/// payload again.
pub fn recover_stale_printing_jobs(db: &DbState) -> Result<usize, String> {
    let conn = lock_conn_recovering(db);
    if is_print_queue_paused_with_conn(&conn, None) {
        return Ok(0);
    }

    let paused_profiles = paused_printer_profiles(&conn);
    let now = Utc::now().to_rfc3339();
    let shared_blocker = active_attempt_predicate_sql("a");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, printer_profile_id
             FROM print_jobs
             WHERE status = 'printing'
               AND julianday(?1) - julianday(updated_at) > (30.0 / 86400.0)
               AND NOT EXISTS (
                   SELECT 1 FROM print_job_attempts a
                   WHERE a.print_job_id = print_jobs.id
                     AND {shared_blocker}
               )",
        ))
        .map_err(|e| format!("prepare stale print jobs query: {e}"))?;
    let recoverable: Vec<(String, Option<String>)> = stmt
        .query_map(params![now], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| format!("query stale print jobs: {e}"))?
        .filter_map(|row| row.ok())
        .filter(|(_, printer_profile_id): &(String, Option<String>)| {
            printer_profile_id
                .as_deref()
                .map(|value| !paused_profiles.contains(value))
                .unwrap_or(true)
        })
        .collect();
    drop(stmt);

    let mut affected = 0usize;
    for (job_id, _) in recoverable {
        affected += conn
            .execute(
                "UPDATE print_jobs
                 SET status = 'failed',
                     retry_count = retry_count + 1,
                     next_retry_at = NULL,
                     last_error = ?1,
                     warning_code = 'stale_printing_unknown',
                     warning_message = ?1,
                     last_attempt_at = COALESCE(last_attempt_at, updated_at),
                     completed_at = ?2,
                     history_expires_at = datetime(?2, '+30 days'),
                     updated_at = ?2
                 WHERE id = ?3 AND status = 'printing'",
                params![STALE_PRINTING_JOB_ERROR, now, job_id],
            )
            .map_err(|e| format!("recover stale printing jobs: {e}"))?;
    }

    if affected > 0 {
        warn!(
            count = affected,
            "Marked stale print jobs failed to prevent automatic duplicate printing"
        );
    }

    Ok(affected)
}

/// Process pending print jobs: generate receipt files and dispatch them.
///
/// This is called by the background worker loop.  It processes one batch of
/// pending jobs each tick.  Returns the number of jobs processed.
fn process_pending_jobs_outcome(
    db: &DbState,
    data_dir: &Path,
) -> Result<PrintProcessOutcome, String> {
    let stale_recovered = recover_stale_printing_jobs(db).unwrap_or(0);
    let manager = {
        let conn = lock_conn_recovering(db);
        DispatchManager::hydrate(&conn)
            .map_err(|error| format!("Hydrate managed print target lanes: {error}"))?
    };
    let mut outcome = process_pending_jobs_with_adapters_outcome(
        db,
        data_dir,
        &manager,
        &SystemManagedRawTransport,
        Arc::new(SystemWindowsSpooler),
        DISPATCH_TIMEOUT,
    )?;
    outcome.changed |= stale_recovered > 0;
    Ok(outcome)
}

#[cfg(test)]
pub fn process_pending_jobs(db: &DbState, data_dir: &Path) -> Result<usize, String> {
    process_pending_jobs_outcome(db, data_dir).map(|outcome| outcome.processed)
}

/// Threshold of consecutive failures before emitting an alert event.
const PRINT_WORKER_FAILURE_ALERT_THRESHOLD: u32 = 10;

/// Kick the print processor without making the caller wait for hardware I/O.
///
/// Payment and kitchen IPC commands should return once the job is durably
/// queued. The spawned processor still attempts immediate dispatch, but a
/// stuck printer driver cannot freeze the checkout action.
pub fn spawn_pending_job_processing(app: tauri::AppHandle, data_dir: PathBuf, context: String) {
    tauri::async_runtime::spawn(async move {
        let app_for_blocking = app.clone();
        let data_dir_for_blocking = data_dir.clone();
        let context_for_log = context.clone();
        let join_result = tokio::task::spawn_blocking(move || {
            use tauri::Manager;
            let db_state = app_for_blocking.state::<db::DbState>();
            process_pending_jobs_outcome(db_state.inner(), &data_dir_for_blocking)
        })
        .await;

        match join_result {
            Ok(Ok(outcome)) => {
                if outcome.processed > 0 {
                    info!(
                        context = %context_for_log,
                        processed = outcome.processed,
                        "Immediate print processing completed"
                    );
                }
                if outcome.changed {
                    notify_print_queue_changed(&app);
                }
            }
            Ok(Err(error)) => {
                warn!(
                    context = %context_for_log,
                    error = %error,
                    "Immediate print processing failed, worker will retry eligible jobs"
                );
            }
            Err(join_err) => {
                warn!(
                    context = %context_for_log,
                    panicked = join_err.is_panic(),
                    "Immediate print processing task failed: {join_err}"
                );
            }
        }
    });
}

trait PrintHistoryPurger: Send + Sync {
    fn purge(
        &self,
        db: &DbState,
        data_dir: &Path,
        now: chrono::DateTime<Utc>,
    ) -> Result<crate::print_history::PrintJobPurgeResult, String>;
}

struct SystemPrintHistoryPurger;

impl PrintHistoryPurger for SystemPrintHistoryPurger {
    fn purge(
        &self,
        db: &DbState,
        data_dir: &Path,
        now: chrono::DateTime<Utc>,
    ) -> Result<crate::print_history::PrintJobPurgeResult, String> {
        crate::print_history::purge_expired_print_jobs_at(db, data_dir, now)
    }
}

fn new_print_history_purge_interval(period: Duration) -> tokio::time::Interval {
    let mut ticker = tokio::time::interval(period);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ticker
}

async fn run_print_history_purge_once<P>(
    db: Arc<DbState>,
    data_dir: PathBuf,
    purger: Arc<P>,
    invalidator: Arc<dyn PrintQueueInvalidator>,
    now: chrono::DateTime<Utc>,
) -> Result<crate::print_history::PrintJobPurgeResult, String>
where
    P: PrintHistoryPurger + ?Sized + 'static,
{
    let result =
        tokio::task::spawn_blocking(move || purger.purge(db.as_ref(), data_dir.as_path(), now))
            .await
            .map_err(|error| format!("Print history purge blocking task failed: {error}"))??;

    if result.rows_deleted > 0 {
        notify_print_queue_changed(invalidator.as_ref());
    }
    Ok(result)
}

async fn run_print_history_purge_loop<P>(
    db: Arc<DbState>,
    data_dir: PathBuf,
    purger: Arc<P>,
    invalidator: Arc<dyn PrintQueueInvalidator>,
    period: Duration,
    cancel: tokio_util::sync::CancellationToken,
) where
    P: PrintHistoryPurger + ?Sized + 'static,
{
    let mut ticker = new_print_history_purge_interval(period);
    loop {
        if cancel.is_cancelled() {
            info!("Print history purge worker cancelled");
            break;
        }

        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                info!("Print history purge worker cancelled");
                break;
            }
            _ = ticker.tick() => {
                match run_print_history_purge_once(
                    Arc::clone(&db),
                    data_dir.clone(),
                    Arc::clone(&purger),
                    Arc::clone(&invalidator),
                    Utc::now(),
                ).await {
                    Ok(result) if result.rows_deleted > 0 => {
                        info!(
                            rows_deleted = result.rows_deleted,
                            files_deleted = result.files_deleted,
                            file_cleanup_skipped = result.file_cleanup_skipped,
                            file_cleanup_failed = result.file_cleanup_failed,
                            "Expired print history purge completed"
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        warn!(error = %error, "Expired print history purge tick failed");
                    }
                }
            }
        }
    }
}

fn start_print_history_purge_worker(
    db: Arc<DbState>,
    app_handle: tauri::AppHandle,
    data_dir: PathBuf,
    cancel: tokio_util::sync::CancellationToken,
) {
    let invalidator: Arc<dyn PrintQueueInvalidator> = Arc::new(app_handle);
    tauri::async_runtime::spawn(run_print_history_purge_loop(
        db,
        data_dir,
        Arc::new(SystemPrintHistoryPurger),
        invalidator,
        PRINT_HISTORY_PURGE_INTERVAL,
        cancel,
    ));
    info!(
        interval_secs = PRINT_HISTORY_PURGE_INTERVAL.as_secs(),
        "Print history purge worker started"
    );
}

/// Start the background print worker loop.
///
/// Runs every `interval_secs` seconds, processes pending print jobs.
/// Emits a `print-worker-alert` Tauri event when consecutive failures exceed
/// the threshold, and resets the counter on any successful tick.
pub fn start_print_worker(
    db: Arc<DbState>,
    app_handle: tauri::AppHandle,
    data_dir: PathBuf,
    interval_secs: u64,
    cancel: tokio_util::sync::CancellationToken,
) {
    use tauri::Emitter;

    start_print_history_purge_worker(
        Arc::clone(&db),
        app_handle.clone(),
        data_dir.clone(),
        cancel.clone(),
    );

    tauri::async_runtime::spawn(async move {
        let interval = tokio::time::Duration::from_secs(interval_secs);
        let mut consecutive_failures: u32 = 0;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = cancel.cancelled() => {
                    info!("Print worker cancelled");
                    break;
                }
            }
            if cancel.is_cancelled() {
                break;
            }
            // Wave 2 C12: `process_pending_jobs` calls `print_raw_to_tcp`,
            // which uses blocking TCP I/O plus `std::thread::sleep` up to
            // 10× per raster payload (~200 ms total). Running that directly
            // on the Tokio async runtime parked whichever worker was
            // executing this tick. `spawn_blocking` moves the call onto a
            // dedicated blocking thread.
            //
            // `spawn_blocking` also catches panics and surfaces them as a
            // `JoinError` with `is_panic() == true`, so the old
            // `catch_unwind` + `AssertUnwindSafe` wrapper is no longer
            // needed — the three-arm match below preserves the same
            // success / business-error / panic behaviour using JoinError
            // for the panic path.
            let db_for_tick = Arc::clone(&db);
            let data_dir_for_tick = data_dir.clone();
            let join_result = tokio::task::spawn_blocking(move || {
                process_pending_jobs_outcome(&db_for_tick, &data_dir_for_tick)
            })
            .await;
            match join_result {
                Ok(Ok(outcome)) => {
                    if outcome.processed > 0 {
                        consecutive_failures = 0;
                    }
                    if outcome.changed {
                        notify_print_queue_changed(&app_handle);
                    }
                }
                Ok(Err(e)) => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    error!(
                        consecutive_failures = consecutive_failures,
                        "Print worker error: {e}"
                    );
                }
                Err(join_err) => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    error!(
                        consecutive_failures = consecutive_failures,
                        panicked = join_err.is_panic(),
                        "Print worker tick failed, will retry next tick: {join_err}"
                    );
                }
            }
            if consecutive_failures >= PRINT_WORKER_FAILURE_ALERT_THRESHOLD
                && consecutive_failures % PRINT_WORKER_FAILURE_ALERT_THRESHOLD == 0
            {
                warn!(
                    consecutive_failures = consecutive_failures,
                    "Print worker has failed {} consecutive times", consecutive_failures
                );
                let _ = app_handle.emit(
                    "print-worker-alert",
                    serde_json::json!({
                        "type": "consecutive_failures",
                        "count": consecutive_failures,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    }),
                );
            }
        }
    });

    info!(interval_secs = interval_secs, "Print worker started");
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::money::Cents;
    use crate::print_dispatch::{
        cancel_managed_submission_before_io, create_attempt, persist_spool_started,
        transition_attempt, ApplyResult, AttemptObservation, DispatchManager, DispatchState,
        NewAttempt, PrinterTargetKey,
    };
    use crate::windows_spooler::FakeWindowsSpooler;
    use rusqlite::{params, Connection};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::ThreadId;

    #[test]
    fn platform_slip_banner_speaks_rider() {
        let metadata = r#"{"food_delivery":{"short_code":"42","payment_method":"cash","prepaid":false,"delivery_provider":"platform_delivery"}}"#;
        assert_eq!(
            platform_slip_banner("efood", metadata, "pending", 5.9),
            Some("EFOOD #42 · ΑΝΤΙΚΑΤΑΒΟΛΗ 5.90€".to_string())
        );

        let prepaid =
            r#"{"food_delivery":{"short_code":"42","payment_method":"online","prepaid":true}}"#;
        assert_eq!(
            platform_slip_banner("efood", prepaid, "paid", 5.9),
            Some("EFOOD #42 · ΠΛΗΡΩΜΕΝΗ".to_string())
        );

        // Platform order without food_delivery metadata (wolt/box today):
        // still branded, payment line only when payment_status says paid.
        assert_eq!(
            platform_slip_banner("wolt", "", "paid", 12.0),
            Some("WOLT · ΠΛΗΡΩΜΕΝΗ".to_string())
        );

        // Non-platform orders get no banner at all.
        assert_eq!(platform_slip_banner("", metadata, "pending", 5.9), None);

        // Internal sources are not delivery platforms: the kiosk route stores
        // platform='web', and 'pos'/'kiosk' receipts must never grow a rider
        // banner even when metadata or payment_status would decorate one.
        assert_eq!(platform_slip_banner("web", metadata, "paid", 5.9), None);
        assert_eq!(platform_slip_banner("kiosk", "", "paid", 5.9), None);
        assert_eq!(platform_slip_banner("pos", "", "pending", 5.9), None);

        // The gate is case-insensitive — sync may deliver 'Efood'.
        assert_eq!(
            platform_slip_banner("Efood", prepaid, "paid", 5.9),
            Some("EFOOD #42 · ΠΛΗΡΩΜΕΝΗ".to_string())
        );
    }

    #[test]
    fn strip_platform_items_fallback_keeps_only_the_customer_note() {
        let ingest_note =
            "Χωρίς κρεμμύδι :-)\n--- Order Items ---\n1x Espresso (1.10)\n1x Freddo (2.10)";
        // Real item rows on the document → the text fallback would print the
        // items twice; only the customer's own note survives.
        assert_eq!(
            strip_platform_items_fallback(ingest_note, true),
            "Χωρίς κρεμμύδι :-)"
        );
        // No parsed items (legacy tokenless path) → the fallback is the only
        // item listing and must stay.
        assert_eq!(
            strip_platform_items_fallback(ingest_note, false),
            ingest_note
        );
        // Plain notes without the marker are untouched either way.
        assert_eq!(
            strip_platform_items_fallback("Ring the bell", true),
            "Ring the bell"
        );
    }

    #[test]
    fn sanitize_path_segment_blocks_traversal_and_control_chars() {
        // Accept: machine-generated ids.
        assert!(sanitize_path_segment("entity_id", "abc-123").is_ok());
        assert!(sanitize_path_segment("entity_id", "550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(sanitize_path_segment("entity_type", "receipt").is_ok());
        assert!(sanitize_path_segment("entity_type", "z_report").is_ok());

        // Reject: path traversal attempts.
        assert!(sanitize_path_segment("entity_id", "../evil").is_err());
        assert!(sanitize_path_segment("entity_id", "..\\evil").is_err());
        assert!(sanitize_path_segment("entity_id", "a/b").is_err());
        assert!(sanitize_path_segment("entity_id", "a\\b").is_err());
        assert!(sanitize_path_segment("entity_id", "..").is_err());

        // Reject: control characters and NUL.
        assert!(sanitize_path_segment("entity_id", "abc\0def").is_err());
        assert!(sanitize_path_segment("entity_id", "abc\ndef").is_err());
        assert!(sanitize_path_segment("entity_id", "abc\tdef").is_err());

        // Reject: empty and over-length.
        assert!(sanitize_path_segment("entity_id", "").is_err());
        assert!(sanitize_path_segment("entity_id", &"a".repeat(129)).is_err());

        // Reject: characters that would be valid in a filename but are
        // filesystem-hostile or reserved on Windows.
        assert!(sanitize_path_segment("entity_id", "a:b").is_err());
        assert!(sanitize_path_segment("entity_id", "a*b").is_err());
        assert!(sanitize_path_segment("entity_id", "a<b").is_err());
    }

    #[test]
    fn provisional_artifact_rollback_reports_safe_artifact_ref_without_owned_path() {
        let data_dir =
            std::env::temp_dir().join(format!("managed-artifact-cleanup-{}", Uuid::new_v4()));
        let artifact = ProvisionalPrintArtifact::create(
            &data_dir,
            "order_receipt",
            "cleanup-order",
            "<html>owned</html>",
        )
        .unwrap();
        let owned_path = artifact.path.clone();
        let artifact_ref = owned_path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.rsplit('_').next())
            .expect("artifact filename should end in a safe UUID");
        assert!(Uuid::parse_str(artifact_ref).is_ok());
        std::fs::remove_file(&owned_path).unwrap();
        std::fs::create_dir(&owned_path).unwrap();

        let error = artifact.rollback().unwrap_err();

        assert!(error.contains("remove provisional print artifact"));
        assert!(error.contains(&format!("artifact_ref={artifact_ref}")));
        assert!(!error.contains(&owned_path.to_string_lossy().to_string()));
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn provisional_artifact_rollback_preserves_a_shared_nonempty_receipts_directory() {
        let data_dir =
            std::env::temp_dir().join(format!("managed-artifact-shared-{}", Uuid::new_v4()));
        let creator = ProvisionalPrintArtifact::create(
            &data_dir,
            "order_receipt",
            "creator-order",
            "<html>creator</html>",
        )
        .unwrap();
        let survivor = ProvisionalPrintArtifact::create(
            &data_dir,
            "order_receipt",
            "survivor-order",
            "<html>survivor</html>",
        )
        .unwrap();
        let survivor_path = survivor.commit();

        creator.rollback().unwrap();

        assert!(Path::new(&survivor_path).exists());
        assert!(data_dir.join(RECEIPTS_DIR).exists());
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn rollback_retries_directory_removal_after_shared_survivor_disappears() {
        let data_dir =
            std::env::temp_dir().join(format!("managed-artifact-race-{}", Uuid::new_v4()));
        let creator = ProvisionalPrintArtifact::create(
            &data_dir,
            "order_receipt",
            "race-creator",
            "<html>creator</html>",
        )
        .unwrap();
        let survivor = ProvisionalPrintArtifact::create(
            &data_dir,
            "order_receipt",
            "race-survivor",
            "<html>survivor</html>",
        )
        .unwrap();
        let survivor_path = PathBuf::from(survivor.commit());
        let hook_called = AtomicBool::new(false);

        creator
            .rollback_with_directory_retry_hook(&|| {
                std::fs::remove_file(&survivor_path).unwrap();
                hook_called.store(true, Ordering::SeqCst);
            })
            .unwrap();

        assert!(hook_called.load(Ordering::SeqCst));
        assert!(!data_dir.join(RECEIPTS_DIR).exists());
        let _ = std::fs::remove_dir_all(data_dir);
    }

    fn test_db() -> DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        DbState {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    fn purge_result(rows_deleted: usize) -> crate::print_history::PrintJobPurgeResult {
        crate::print_history::PrintJobPurgeResult {
            rows_deleted,
            files_deleted: 0,
            file_cleanup_skipped: 0,
            file_cleanup_failed: 0,
            durable_changed: rows_deleted > 0,
        }
    }

    struct ScriptedPrintHistoryPurger {
        calls: AtomicUsize,
        thread_ids: Mutex<Vec<ThreadId>>,
        results: Mutex<VecDeque<Result<crate::print_history::PrintJobPurgeResult, String>>>,
    }

    impl ScriptedPrintHistoryPurger {
        fn new(
            results: impl IntoIterator<Item = Result<crate::print_history::PrintJobPurgeResult, String>>,
        ) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                thread_ids: Mutex::new(Vec::new()),
                results: Mutex::new(results.into_iter().collect()),
            }
        }
    }

    impl PrintHistoryPurger for ScriptedPrintHistoryPurger {
        fn purge(
            &self,
            _db: &DbState,
            _data_dir: &Path,
            _now: chrono::DateTime<Utc>,
        ) -> Result<crate::print_history::PrintJobPurgeResult, String> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            self.thread_ids
                .lock()
                .unwrap()
                .push(std::thread::current().id());
            self.results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(purge_result(0)))
        }
    }

    struct RecordingHistoryInvalidator {
        db: Arc<DbState>,
        calls: AtomicUsize,
        remaining_rows: Option<tokio::sync::mpsc::UnboundedSender<i64>>,
    }

    impl RecordingHistoryInvalidator {
        fn counting(db: Arc<DbState>) -> Arc<Self> {
            Arc::new(Self {
                db,
                calls: AtomicUsize::new(0),
                remaining_rows: None,
            })
        }

        fn observing(db: Arc<DbState>) -> (Arc<Self>, tokio::sync::mpsc::UnboundedReceiver<i64>) {
            let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
            (
                Arc::new(Self {
                    db,
                    calls: AtomicUsize::new(0),
                    remaining_rows: Some(sender),
                }),
                receiver,
            )
        }
    }

    impl PrintQueueInvalidator for RecordingHistoryInvalidator {
        fn invalidate_print_queue(&self) {
            let conn = self
                .db
                .conn
                .try_lock()
                .expect("history purge must release the DB guard before invalidating");
            let remaining = conn
                .query_row("SELECT COUNT(*) FROM print_jobs", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count rows visible after history purge");
            drop(conn);
            self.calls.fetch_add(1, Ordering::AcqRel);
            if let Some(sender) = &self.remaining_rows {
                let _ = sender.send(remaining);
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn print_history_purge_runtime_uses_daily_skip_schedule() {
        let ticker = new_print_history_purge_interval(PRINT_HISTORY_PURGE_INTERVAL);

        assert_eq!(ticker.period(), Duration::from_secs(24 * 60 * 60));
        assert_eq!(
            ticker.missed_tick_behavior(),
            tokio::time::MissedTickBehavior::Skip
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn print_history_purge_runtime_offloads_each_tick_and_skips_noop_invalidation() {
        let db = Arc::new(test_db());
        let purger = Arc::new(ScriptedPrintHistoryPurger::new([Ok(purge_result(0))]));
        let invalidator = RecordingHistoryInvalidator::counting(Arc::clone(&db));
        let runtime_thread = std::thread::current().id();

        let result = run_print_history_purge_once(
            db,
            std::env::temp_dir(),
            Arc::clone(&purger),
            invalidator.clone(),
            "2026-08-11T12:00:00Z".parse().unwrap(),
        )
        .await
        .expect("no-op purge tick");

        assert_eq!(result.rows_deleted, 0);
        assert_eq!(purger.calls.load(Ordering::Acquire), 1);
        assert_ne!(purger.thread_ids.lock().unwrap()[0], runtime_thread);
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn print_history_purge_runtime_prioritizes_pre_cancelled_worker() {
        let db = Arc::new(test_db());
        let purger = Arc::new(ScriptedPrintHistoryPurger::new([Ok(purge_result(1))]));
        let invalidator = RecordingHistoryInvalidator::counting(Arc::clone(&db));
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();

        run_print_history_purge_loop(
            db,
            std::env::temp_dir(),
            Arc::clone(&purger),
            invalidator.clone(),
            Duration::from_millis(1),
            cancel,
        )
        .await;

        assert_eq!(purger.calls.load(Ordering::Acquire), 0);
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn print_history_purge_runtime_runs_immediately_while_paused_one_capped_batch_per_tick() {
        let db = Arc::new(test_db());
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "printing", "queue_paused", "true").unwrap();
            db::set_setting(
                &conn,
                "printing",
                "queue_paused_profile::profile-paused",
                "true",
            )
            .unwrap();
            for index in 0..201 {
                conn.execute(
                    "INSERT INTO print_jobs (
                        id, entity_type, entity_id, printer_profile_id, status,
                        created_at, updated_at, completed_at, history_expires_at
                     ) VALUES (
                        ?1, 'order_receipt', ?1, 'profile-paused', 'printed',
                        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
                        '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z'
                     )",
                    [format!("scheduled-purge-{index:03}")],
                )
                .unwrap();
            }
        }
        let (invalidator, mut remaining_rows) =
            RecordingHistoryInvalidator::observing(Arc::clone(&db));
        let cancel = tokio_util::sync::CancellationToken::new();
        let worker = tokio::spawn(run_print_history_purge_loop(
            Arc::clone(&db),
            std::env::temp_dir(),
            Arc::new(SystemPrintHistoryPurger),
            invalidator.clone(),
            PRINT_HISTORY_PURGE_INTERVAL,
            cancel.clone(),
        ));

        let remaining = tokio::time::timeout(Duration::from_secs(5), remaining_rows.recv())
            .await
            .expect("startup purge must not wait 24 hours")
            .expect("changed startup purge invalidation");
        assert_eq!(remaining, 1, "one startup tick must purge at most 200 rows");
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 1);

        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(5), worker)
            .await
            .expect("purge worker observes cancellation")
            .expect("purge worker join");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn print_history_purge_runtime_isolates_errors_and_invalidates_only_changed_tick() {
        let db = Arc::new(test_db());
        let purger = Arc::new(ScriptedPrintHistoryPurger::new([
            Err("forced purge failure".to_string()),
            Ok(purge_result(1)),
        ]));
        let (invalidator, mut invalidations) =
            RecordingHistoryInvalidator::observing(Arc::clone(&db));
        let cancel = tokio_util::sync::CancellationToken::new();
        let worker = tokio::spawn(run_print_history_purge_loop(
            db,
            std::env::temp_dir(),
            Arc::clone(&purger),
            invalidator.clone(),
            Duration::from_millis(10),
            cancel.clone(),
        ));

        tokio::time::timeout(Duration::from_secs(5), invalidations.recv())
            .await
            .expect("loop must continue after a purge error")
            .expect("successful changed tick invalidation");
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(5), worker)
            .await
            .expect("purge worker observes cancellation")
            .expect("purge worker join");

        assert!(purger.calls.load(Ordering::Acquire) >= 2);
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 1);
    }

    fn test_file_db() -> DbState {
        let path = std::env::temp_dir().join(format!(
            "the-small-task7-control-{}-{}.sqlite",
            std::process::id(),
            Uuid::new_v4()
        ));
        let conn = Connection::open(&path).expect("open task7 file db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("task7 file db pragmas");
        db::run_migrations_for_test(&conn);
        DbState {
            conn: Mutex::new(conn),
            db_path: path,
        }
    }

    fn assert_parent_has_no_managed_preparation_effects(conn: &Connection, job_id: &str) {
        let parent: (
            String,
            Option<String>,
            Option<i64>,
            Option<Vec<u8>>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT status, printer_profile_id, document_snapshot_version,
                        document_snapshot_zlib, document_snapshot_sha256,
                        render_profile_snapshot_json, output_path
                 FROM print_jobs WHERE id = ?1",
                [job_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            parent,
            ("pending".into(), None, None, None, None, None, None)
        );
    }

    fn mark_job_printing_for_test(db: &DbState, job_id: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE print_jobs SET status = 'printing' WHERE id = ?1",
            params![job_id],
        )
        .unwrap();
    }

    fn assert_terminal_parent_history(conn: &Connection, job_id: &str, expected_status: &str) {
        let row: (String, String, Option<String>, Option<String>, Option<bool>) = conn
            .query_row(
                "SELECT status, updated_at, completed_at, history_expires_at,
                        history_expires_at = datetime(completed_at, '+30 days')
                 FROM print_jobs WHERE id = ?1",
                [job_id],
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
            .unwrap();
        assert_eq!(row.0, expected_status);
        assert_eq!(row.2.as_deref(), Some(row.1.as_str()));
        assert!(row.3.is_some(), "terminal history expiry must be stored");
        assert_eq!(
            row.4,
            Some(true),
            "terminal history expiry must be exactly +30 days"
        );
    }

    fn assert_parent_history_is_clear(conn: &Connection, job_id: &str, expected_status: &str) {
        let row: (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT status, completed_at, history_expires_at
                 FROM print_jobs WHERE id = ?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (expected_status.to_owned(), None, None));
    }

    fn insert_control_job(
        conn: &Connection,
        status: &str,
        printer_profile_id: Option<&str>,
    ) -> String {
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO print_jobs
             (id, entity_type, entity_id, printer_profile_id, status, created_at, updated_at)
             VALUES (?1, 'order_receipt', ?1, ?2, ?3,
                     '2026-08-07T09:00:00Z', '2026-08-07T09:00:00Z')",
            params![id, printer_profile_id, status],
        )
        .unwrap();
        id
    }

    fn add_queued_windows_attempt(
        conn: &Connection,
        job_id: &str,
        queue: &str,
        spool_job_id: u32,
    ) -> Uuid {
        let now = Utc::now();
        let attempt = create_attempt(
            conn,
            NewAttempt {
                local_job_id: job_id.to_owned(),
                target: PrinterTargetKey::WindowsQueue(queue.to_owned()),
                document_kind: "receipt".into(),
                bytes_requested: 10,
                now,
            },
        )
        .unwrap();
        transition_attempt(
            conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            AttemptObservation {
                now,
                ..AttemptObservation::default()
            },
        )
        .unwrap();
        let marker = crate::print_dispatch::read_attempt(conn, attempt.attempt_id)
            .unwrap()
            .unwrap()
            .document_name;
        persist_spool_started(
            conn,
            attempt.attempt_id,
            &crate::windows_spooler::SpoolStarted {
                job_id: spool_job_id,
                printer_name: queue.to_owned(),
                document_name: marker,
                submitted_at: now,
            },
        )
        .unwrap();
        attempt.attempt_id
    }

    /// A raw TCP attempt parked in 'unknown' — the exact durable residue of
    /// the 19/08 shop incident: the worker died mid-write (os error 10060)
    /// and left the printer lane bricked.
    fn add_unknown_raw_attempt(conn: &Connection, job_id: &str) -> Uuid {
        let now = Utc::now();
        let attempt = create_attempt(
            conn,
            NewAttempt {
                local_job_id: job_id.to_owned(),
                target: PrinterTargetKey::RawTcp {
                    host: "192.168.1.19".into(),
                    port: 9100,
                },
                document_kind: "receipt".into(),
                bytes_requested: 109_831,
                now,
            },
        )
        .unwrap();
        transition_attempt(
            conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            AttemptObservation {
                now,
                ..AttemptObservation::default()
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE print_job_attempts SET state = 'unknown' WHERE id = ?1",
            [attempt.attempt_id.to_string()],
        )
        .unwrap();
        attempt.attempt_id
    }

    /// 19/08 shop deadlock, single-job cancel: a dead raw attempt in
    /// 'unknown' must be finalizable by the operator, clearing both the
    /// active count and the attention (stale) count.
    #[test]
    fn dead_raw_unknown_attempt_is_cancelled_and_frees_the_queue() {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        let (job_id, attempt_id) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "failed", Some("profile-lan"));
            let attempt_id = add_unknown_raw_attempt(&conn, &job_id);
            (job_id, attempt_id)
        };

        let before = print_queue_snapshot(&db, None, None, 20, 0).unwrap();
        assert_eq!(before.counts.active, 1, "the dead attempt counts active");
        assert_eq!(before.counts.stale, 1, "and needs attention");

        let result = durable_cancel_print_job(&db, &job_id).unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["affected"], 1);
        assert_eq!(result["durableChanged"], true);

        let conn = db.conn.lock().unwrap();
        let attempt = crate::print_dispatch::read_attempt(&conn, attempt_id)
            .unwrap()
            .unwrap();
        assert_eq!(attempt.state, DispatchState::Cancelled);
        drop(conn);

        let after = print_queue_snapshot(&db, None, None, 20, 0).unwrap();
        assert_eq!(after.counts.active, 0, "the lane blocker is gone");
        assert_eq!(after.counts.stale, 0, "the attention badge clears");
        assert_eq!(after.counts.history, 1, "the failed job stays visible");
    }

    /// The dead-attempt finalization must never touch a LIVE raw worker —
    /// that one keeps the cooperative stop flow.
    #[test]
    fn live_raw_attempt_keeps_the_cooperative_cancel_flow() {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        let (job_id, attempt_id) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "printing", Some("profile-lan"));
            let attempt_id = add_unknown_raw_attempt(&conn, &job_id);
            (job_id, attempt_id)
        };

        let guard = ActivePrintGuard::register(&db, &job_id, None).unwrap();
        let result = durable_cancel_print_job(&db, &job_id).unwrap();
        assert_eq!(
            result["activeStopsRequested"], 1,
            "a live worker gets the cooperative stop"
        );

        let conn = db.conn.lock().unwrap();
        let attempt = crate::print_dispatch::read_attempt(&conn, attempt_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            attempt.state,
            DispatchState::Unknown,
            "a live attempt is never force-finalized"
        );
        drop(conn);
        drop(guard);
    }

    /// 19/08 shop deadlock, bulk path: «Παύση και ακύρωση εργασιών POS» must
    /// finalize the same dead raw attempts instead of reporting failure.
    #[test]
    fn bulk_cancel_finalizes_dead_raw_unknown_attempts() {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        let (job_id, attempt_id) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "failed", Some("profile-lan"));
            let attempt_id = add_unknown_raw_attempt(&conn, &job_id);
            (job_id, attempt_id)
        };

        let plan = durable_pause_and_cancel_pos_jobs(&db, None, Utc::now()).unwrap();
        assert!(plan.affected >= 1, "the dead attempt's job counts affected");

        let conn = db.conn.lock().unwrap();
        let attempt = crate::print_dispatch::read_attempt(&conn, attempt_id)
            .unwrap()
            .unwrap();
        assert_eq!(attempt.state, DispatchState::Cancelled);
        let status: String = conn
            .query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [job_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "failed", "a failed parent keeps its history story");
    }

    fn add_terminal_windows_attempt(conn: &Connection, job_id: &str, queue: &str) -> Uuid {
        let now = Utc::now();
        let attempt = create_attempt(
            conn,
            NewAttempt {
                local_job_id: job_id.to_owned(),
                target: PrinterTargetKey::WindowsQueue(queue.to_owned()),
                document_kind: "receipt".into(),
                bytes_requested: 10,
                now,
            },
        )
        .unwrap();
        transition_attempt(
            conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            AttemptObservation {
                now,
                ..AttemptObservation::default()
            },
        )
        .unwrap();
        transition_attempt(
            conn,
            attempt.attempt_id,
            DispatchState::Sent,
            AttemptObservation {
                now,
                ..AttemptObservation::default()
            },
        )
        .unwrap();
        attempt.attempt_id
    }

    #[test]
    fn bulk_pause_cancel_durable_phase_is_atomic_and_keeps_windows_parent_unconfirmed() {
        let db = test_db();
        let (local_job, windows_job, windows_attempt) = {
            let conn = db.conn.lock().unwrap();
            let local_job = insert_control_job(&conn, "pending", Some("profile-local"));
            let windows_job = insert_control_job(&conn, "dispatched", Some("profile-default"));
            let windows_attempt =
                add_queued_windows_attempt(&conn, &windows_job, "Front Queue", 73);
            (local_job, windows_job, windows_attempt)
        };

        let plan = durable_pause_and_cancel_pos_jobs(&db, None, Utc::now()).unwrap();

        assert_eq!(plan.affected, 2);
        assert_eq!(plan.unchanged, 0);
        assert_eq!(plan.local_cancelled, 1);
        assert_eq!(plan.windows_attempt_ids, vec![windows_attempt]);
        let conn = db.conn.lock().unwrap();
        assert!(is_print_queue_paused_with_conn(&conn, None));
        let local: (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT status, completed_at, history_expires_at FROM print_jobs WHERE id = ?1",
                [&local_job],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(local.0, "cancelled");
        assert!(local.1.is_some() && local.2.is_some());
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&windows_job],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "dispatched"
        );
        let attempt = crate::print_dispatch::read_attempt(&conn, windows_attempt)
            .unwrap()
            .unwrap();
        assert_eq!(attempt.state, DispatchState::CancelRequested);
        assert!(attempt.cancel_confirmed_at.is_none());
    }

    #[test]
    fn profile_bulk_pause_cancel_includes_resolved_default_profile_and_excludes_other_profile() {
        let db = test_db();
        let (default_job, default_attempt, other_job, other_attempt) = {
            let conn = db.conn.lock().unwrap();
            let default_job = insert_control_job(&conn, "dispatched", Some("profile-default"));
            let default_attempt =
                add_queued_windows_attempt(&conn, &default_job, "Front Queue", 73);
            let other_job = insert_control_job(&conn, "dispatched", Some("profile-other"));
            let other_attempt = add_queued_windows_attempt(&conn, &other_job, "Back Queue", 74);
            (default_job, default_attempt, other_job, other_attempt)
        };

        let plan =
            durable_pause_and_cancel_pos_jobs(&db, Some("profile-default"), Utc::now()).unwrap();

        assert_eq!(plan.affected, 1);
        assert_eq!(plan.local_cancelled, 0);
        assert_eq!(plan.windows_attempt_ids, vec![default_attempt]);
        let conn = db.conn.lock().unwrap();
        assert!(is_print_queue_paused_with_conn(
            &conn,
            Some("profile-default")
        ));
        assert!(!is_print_queue_paused_with_conn(
            &conn,
            Some("profile-other")
        ));
        assert_eq!(
            crate::print_dispatch::read_attempt(&conn, default_attempt)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::CancelRequested
        );
        assert_eq!(
            crate::print_dispatch::read_attempt(&conn, other_attempt)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::WindowsQueued
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&default_job],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "dispatched"
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&other_job],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "dispatched"
        );
    }

    #[test]
    fn bulk_pause_cancel_persistence_failure_rolls_back_pause_and_every_job_change() {
        let db = test_db();
        let (local_job, windows_job, windows_attempt) = {
            let conn = db.conn.lock().unwrap();
            let local_job = insert_control_job(&conn, "pending", Some("profile-a"));
            let windows_job = insert_control_job(&conn, "dispatched", Some("profile-a"));
            let windows_attempt =
                add_queued_windows_attempt(&conn, &windows_job, "Front Queue", 73);
            conn.execute_batch(
                "CREATE TRIGGER fail_task7_cancel_attempt
                 BEFORE UPDATE OF state ON print_job_attempts
                 WHEN NEW.state = 'cancel_requested'
                 BEGIN
                     SELECT RAISE(ABORT, 'injected task7 durable failure');
                 END;",
            )
            .unwrap();
            (local_job, windows_job, windows_attempt)
        };

        assert!(durable_pause_and_cancel_pos_jobs(&db, None, Utc::now()).is_err());

        let conn = db.conn.lock().unwrap();
        assert!(!is_print_queue_paused_with_conn(&conn, None));
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&local_job],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "pending"
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&windows_job],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "dispatched"
        );
        assert_eq!(
            crate::print_dispatch::read_attempt(&conn, windows_attempt)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::WindowsQueued
        );
    }

    #[test]
    fn individual_windows_cancel_reports_native_request_without_false_confirmation() {
        let db = test_file_db();
        let (job_id, attempt_id, marker) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "dispatched", Some("profile-a"));
            let attempt_id = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            let marker = crate::print_dispatch::read_attempt(&conn, attempt_id)
                .unwrap()
                .unwrap()
                .document_name;
            (job_id, attempt_id, marker)
        };
        let spooler = Arc::new(FakeWindowsSpooler::new(73));
        spooler.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
            job_id: 73,
            printer_name: "Front Queue".into(),
            document_name: marker,
            status_text: Some("Spooling".into()),
            status_bits: 0x8,
            position: 1,
            total_pages: 1,
            pages_printed: 0,
        });

        let result =
            cancel_print_job_with_spooler(&db, &job_id, spooler.clone(), Duration::from_secs(1))
                .unwrap();

        assert_eq!(result["nativeControlsRequested"], 1);
        assert_eq!(result["nativeControlsConfirmed"], 0);
        assert_eq!(result["nativeControlsFailed"], 0);
        assert_eq!(result["ownershipRefused"], 0);
        assert_eq!(spooler.controls().len(), 1);
        let conn = db.conn.lock().unwrap();
        let attempt = crate::print_dispatch::read_attempt(&conn, attempt_id)
            .unwrap()
            .unwrap();
        assert_eq!(attempt.state, DispatchState::CancelRequested);
        assert!(attempt.cancel_confirmed_at.is_none());
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn typed_queue_prefers_newest_active_attempt_over_newer_terminal_epoch_and_counts_jobs_once() {
        let db = test_db();
        let job_id = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "failed", Some("profile-a"));
            let older_attempt = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            conn.execute(
                "UPDATE print_job_attempts SET state = 'unknown' WHERE id = ?1",
                [older_attempt.to_string()],
            )
            .unwrap();
            add_queued_windows_attempt(&conn, &job_id, "Front Queue", 74);
            add_terminal_windows_attempt(&conn, &job_id, "Front Queue");
            job_id
        };

        let snapshot = print_queue_snapshot(&db, None, None, 20, 0).unwrap();
        let job = snapshot
            .jobs
            .iter()
            .find(|candidate| candidate.id == job_id)
            .unwrap();

        assert_eq!(job.transport_state.as_deref(), Some("windows_queued"));
        assert_eq!(job.windows_job_id, Some(74));
        assert!(job.capabilities.cancellable);
        assert_eq!(snapshot.counts.active, 1);
        assert_eq!(snapshot.counts.stale, 1);
        assert_eq!(snapshot.counts.history, 0);
    }

    #[test]
    fn individual_cancel_controls_every_owned_active_windows_attempt_hidden_by_newer_terminal_epoch(
    ) {
        let db = test_file_db();
        let (job_id, older_attempt, newer_active_attempt, markers) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "failed", Some("profile-a"));
            let older_attempt = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            conn.execute(
                "UPDATE print_job_attempts SET state = 'unknown' WHERE id = ?1",
                [older_attempt.to_string()],
            )
            .unwrap();
            let newer_active_attempt =
                add_queued_windows_attempt(&conn, &job_id, "Front Queue", 74);
            add_terminal_windows_attempt(&conn, &job_id, "Front Queue");
            let markers = [older_attempt, newer_active_attempt].map(|attempt_id| {
                crate::print_dispatch::read_attempt(&conn, attempt_id)
                    .unwrap()
                    .unwrap()
                    .document_name
            });
            (job_id, older_attempt, newer_active_attempt, markers)
        };
        let spooler = Arc::new(FakeWindowsSpooler::new(73));
        for (job_id, document_name) in [(73, markers[0].clone()), (74, markers[1].clone())] {
            spooler.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
                job_id,
                printer_name: "Front Queue".into(),
                document_name,
                status_text: Some("Spooling".into()),
                status_bits: 0x8,
                position: 1,
                total_pages: 1,
                pages_printed: 0,
            });
        }

        let result = cancel_print_job_with_spooler(
            &db,
            &job_id,
            Arc::clone(&spooler),
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(result["affected"], 1);
        assert_eq!(result["nativeControlsRequested"], 2);
        let mut controlled = spooler
            .controls()
            .into_iter()
            .map(|control| control.job_id)
            .collect::<Vec<_>>();
        controlled.sort_unstable();
        assert_eq!(controlled, vec![73, 74]);
        let conn = db.conn.lock().unwrap();
        for attempt_id in [older_attempt, newer_active_attempt] {
            assert_eq!(
                crate::print_dispatch::read_attempt(&conn, attempt_id)
                    .unwrap()
                    .unwrap()
                    .state,
                DispatchState::CancelRequested
            );
        }
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn bulk_pause_cancel_requests_each_owned_active_attempt_once_when_terminal_epoch_is_newest() {
        let db = test_file_db();
        let (_job_id, markers) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "failed", Some("profile-a"));
            let first = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            let second = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 74);
            add_terminal_windows_attempt(&conn, &job_id, "Front Queue");
            let markers = [first, second].map(|attempt_id| {
                crate::print_dispatch::read_attempt(&conn, attempt_id)
                    .unwrap()
                    .unwrap()
                    .document_name
            });
            (job_id, markers)
        };
        let spooler = Arc::new(FakeWindowsSpooler::new(73));
        for (job_id, document_name) in [(73, markers[0].clone()), (74, markers[1].clone())] {
            spooler.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
                job_id,
                printer_name: "Front Queue".into(),
                document_name,
                status_text: Some("Spooling".into()),
                status_bits: 0x8,
                position: 1,
                total_pages: 1,
                pages_printed: 0,
            });
        }

        let result = pause_and_cancel_pos_jobs_with_spooler(
            &db,
            Some("profile-a"),
            Arc::clone(&spooler),
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(result["affected"], 1);
        assert_eq!(result["nativeControlsRequested"], 2);
        assert_eq!(result["activeStopsRequested"], 0);
        let mut controlled = spooler
            .controls()
            .into_iter()
            .map(|control| control.job_id)
            .collect::<Vec<_>>();
        controlled.sort_unstable();
        assert_eq!(controlled, vec![73, 74]);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pause_and_resume_select_each_owned_active_attempt_when_terminal_epoch_is_newest() {
        let db = test_file_db();
        let (job_id, attempts, markers) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "failed", Some("profile-a"));
            let first = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            let second = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 74);
            add_terminal_windows_attempt(&conn, &job_id, "Front Queue");
            let markers = [first, second].map(|attempt_id| {
                crate::print_dispatch::read_attempt(&conn, attempt_id)
                    .unwrap()
                    .unwrap()
                    .document_name
            });
            (job_id, [first, second], markers)
        };
        let spooler = Arc::new(FakeWindowsSpooler::new(73));
        for (job_id, document_name) in [(73, markers[0].clone()), (74, markers[1].clone())] {
            spooler.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
                job_id,
                printer_name: "Front Queue".into(),
                document_name,
                status_text: Some("Spooling".into()),
                status_bits: 0x8,
                position: 1,
                total_pages: 1,
                pages_printed: 0,
            });
        }

        let paused = set_print_queue_paused_with_spooler(
            &db,
            Some("profile-a"),
            true,
            Arc::clone(&spooler),
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(paused["nativeControlsRequested"], 2);
        {
            let conn = db.conn.lock().unwrap();
            for attempt_id in attempts {
                conn.execute(
                    "UPDATE print_job_attempts SET state = 'paused' WHERE id = ?1",
                    [attempt_id.to_string()],
                )
                .unwrap();
            }
        }
        for (job_id, document_name) in [(73, markers[0].clone()), (74, markers[1].clone())] {
            spooler.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
                job_id,
                printer_name: "Front Queue".into(),
                document_name,
                status_text: Some("Paused".into()),
                status_bits: 0x21,
                position: 1,
                total_pages: 1,
                pages_printed: 0,
            });
        }

        let resumed = set_print_queue_paused_with_spooler(
            &db,
            Some("profile-a"),
            false,
            Arc::clone(&spooler),
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(resumed["nativeControlsRequested"], 2);
        let controls = spooler.controls();
        assert_eq!(controls.len(), 4);
        assert_eq!(
            controls
                .iter()
                .filter(|control| control.control == crate::windows_spooler::SpoolJobControl::Pause)
                .count(),
            2
        );
        assert_eq!(
            controls
                .iter()
                .filter(|control| control.control == crate::windows_spooler::SpoolJobControl::Resume)
                .count(),
            2
        );
        assert_eq!(
            controls
                .iter()
                .map(|control| control.job_id)
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from([73, 74])
        );
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT status FROM print_jobs WHERE id = ?1",
                    [&job_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "failed"
        );
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reconciliation_observes_an_older_owned_active_attempt_hidden_by_newer_terminal_epoch() {
        let db = test_file_db();
        let (job_id, attempt_id, marker, manager) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "failed", Some("profile-a"));
            let attempt_id = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            conn.execute(
                "UPDATE print_job_attempts SET state = 'unknown' WHERE id = ?1",
                [attempt_id.to_string()],
            )
            .unwrap();
            add_terminal_windows_attempt(&conn, &job_id, "Front Queue");
            let marker = crate::print_dispatch::read_attempt(&conn, attempt_id)
                .unwrap()
                .unwrap()
                .document_name;
            let manager = DispatchManager::hydrate(&conn).unwrap();
            (job_id, attempt_id, marker, manager)
        };
        let spooler = Arc::new(FakeWindowsSpooler::new(73));
        spooler.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
            job_id: 73,
            printer_name: "Front Queue".into(),
            document_name: marker,
            status_text: Some("Spooling".into()),
            status_bits: 0x8,
            position: 1,
            total_pages: 1,
            pages_printed: 0,
        });

        let counts = reconcile_windows_attempts_bounded(
            &db,
            &manager,
            spooler as Arc<dyn WindowsSpooler>,
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(
            counts,
            WindowsReconcileCounts {
                observed: 1,
                failed: 0,
            }
        );
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            crate::print_dispatch::read_attempt(&conn, attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::WindowsQueued
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "failed"
        );
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn individual_windows_cancel_refuses_reused_job_id_without_native_control() {
        let db = test_file_db();
        let job_id = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "dispatched", Some("profile-a"));
            add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            job_id
        };
        let spooler = Arc::new(FakeWindowsSpooler::new(73));
        spooler.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
            job_id: 73,
            printer_name: "Front Queue".into(),
            document_name: crate::windows_spooler::format_document_marker(
                Uuid::new_v4(),
                Uuid::new_v4(),
                "receipt",
            )
            .unwrap(),
            status_text: None,
            status_bits: 0,
            position: 1,
            total_pages: 1,
            pages_printed: 0,
        });

        let result =
            cancel_print_job_with_spooler(&db, &job_id, spooler.clone(), Duration::from_secs(1))
                .unwrap();

        assert_eq!(result["nativeControlsRequested"], 0);
        assert_eq!(result["nativeControlsConfirmed"], 0);
        assert_eq!(result["nativeControlsFailed"], 0);
        assert_eq!(result["ownershipRefused"], 1);
        assert!(spooler.controls().is_empty());
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn zero_spool_job_id_is_refused_and_skipped_by_bounded_native_paths() {
        let db = test_file_db();
        let (job_id, attempt_id, manager) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "dispatched", Some("profile-a"));
            let attempt_id = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            let manager = DispatchManager::hydrate(&conn).unwrap();
            conn.execute(
                "UPDATE print_job_attempts SET spool_job_id = 0 WHERE id = ?1",
                [attempt_id.to_string()],
            )
            .unwrap();
            (job_id, attempt_id, manager)
        };
        let control_spooler = Arc::new(FakeWindowsSpooler::new(73));

        let control = cancel_print_job_with_spooler(
            &db,
            &job_id,
            Arc::clone(&control_spooler),
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(control["nativeControlsRequested"], 0);
        assert_eq!(control["nativeControlsConfirmed"], 0);
        assert_eq!(control["nativeControlsFailed"], 0);
        assert_eq!(control["ownershipRefused"], 1);
        assert!(control_spooler.controls().is_empty());

        let reconciliation_spooler = Arc::new(BlockingReconciliationSpooler {
            blocked_target: "Never Blocks".into(),
            state: (
                Mutex::new(BlockingReconciliationState::default()),
                std::sync::Condvar::new(),
            ),
        });
        let reconciliation = reconcile_windows_attempts_bounded(
            &db,
            &manager,
            Arc::clone(&reconciliation_spooler) as Arc<dyn WindowsSpooler>,
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(reconciliation, WindowsReconcileCounts::default());
        assert_eq!(reconciliation_spooler.calls_for("Front Queue"), 0);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT state FROM print_job_attempts WHERE id = ?1",
                [attempt_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "cancel_requested"
        );
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn bounded_reconciliation_skips_corrupt_job_ids_and_observes_healthy_target() {
        let db = test_file_db();
        let suffix = Uuid::new_v4();
        let corrupt_cases = [
            (format!("Zero {suffix}"), 0_i64),
            (format!("Negative {suffix}"), -1_i64),
            (format!("Too Large {suffix}"), i64::from(u32::MAX) + 1),
        ];
        let healthy_queue = format!("Healthy {suffix}");
        let (manager, corrupt_attempts) = {
            let conn = db.conn.lock().unwrap();
            let mut corrupt_attempts = Vec::new();
            for (queue, invalid_job_id) in &corrupt_cases {
                let job_id = insert_control_job(&conn, "dispatched", Some("profile-corrupt"));
                let attempt_id = add_queued_windows_attempt(&conn, &job_id, queue, 73);
                conn.execute(
                    "UPDATE print_job_attempts SET spool_job_id = ?1 WHERE id = ?2",
                    params![invalid_job_id, attempt_id.to_string()],
                )
                .unwrap();
                corrupt_attempts.push(attempt_id);
            }
            let healthy_job = insert_control_job(&conn, "dispatched", Some("profile-healthy"));
            add_queued_windows_attempt(&conn, &healthy_job, &healthy_queue, 74);
            let manager = DispatchManager::hydrate(&conn)
                .expect("corrupt JobIds must not abort hydration for a healthy target");
            (manager, corrupt_attempts)
        };
        let spooler = Arc::new(BlockingReconciliationSpooler {
            blocked_target: "Never Blocks".into(),
            state: (
                Mutex::new(BlockingReconciliationState::default()),
                std::sync::Condvar::new(),
            ),
        });

        let counts = reconcile_windows_attempts_bounded(
            &db,
            &manager,
            Arc::clone(&spooler) as Arc<dyn WindowsSpooler>,
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(
            counts,
            WindowsReconcileCounts {
                observed: 1,
                failed: 0,
            }
        );
        assert_eq!(spooler.calls_for(&healthy_queue), 1);
        for (queue, _) in &corrupt_cases {
            assert_eq!(spooler.calls_for(queue), 0);
        }
        let conn = db.conn.lock().unwrap();
        for (attempt_id, (_, invalid_job_id)) in corrupt_attempts.iter().zip(corrupt_cases.iter()) {
            let row: (i64, String, Option<String>) = conn
                .query_row(
                    "SELECT spool_job_id, state, completed_at
                     FROM print_job_attempts WHERE id = ?1",
                    [attempt_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(row, (*invalid_job_id, "windows_queued".into(), None));
        }
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn repeated_windows_cancel_reports_native_failure_persistence_as_durable_change() {
        let db = test_file_db();
        let (job_id, attempt_id) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "dispatched", Some("profile-a"));
            let attempt_id = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            conn.execute(
                "UPDATE print_job_attempts
                 SET state = 'cancel_requested',
                     cancel_requested_at = datetime('now')
                 WHERE id = ?1",
                [attempt_id.to_string()],
            )
            .unwrap();
            (job_id, attempt_id)
        };
        // No seeded native job: exact ownership cannot be confirmed, so the
        // bounded control path must persist cancel_failed/open-circuit state.
        let spooler = Arc::new(FakeWindowsSpooler::new(73));

        let result =
            cancel_print_job_with_spooler(&db, &job_id, spooler, Duration::from_secs(1)).unwrap();

        assert_eq!(result["ownershipRefused"], 1);
        assert_eq!(result["durableChanged"], true);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            crate::print_dispatch::read_attempt(&conn, attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::CancelFailed
        );
        assert_eq!(
            conn.query_row(
                "SELECT circuit_state FROM print_target_state LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "open"
        );
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    struct PerTargetBlockingSpooler {
        snapshots: Mutex<HashMap<(String, u32), crate::windows_spooler::SpoolJobSnapshot>>,
        controls: Mutex<Vec<(String, u32)>>,
        blocked: (Mutex<(bool, bool)>, std::sync::Condvar),
    }

    impl PerTargetBlockingSpooler {
        fn new(snapshots: Vec<crate::windows_spooler::SpoolJobSnapshot>) -> Self {
            Self {
                snapshots: Mutex::new(
                    snapshots
                        .into_iter()
                        .map(|snapshot| {
                            ((snapshot.printer_name.clone(), snapshot.job_id), snapshot)
                        })
                        .collect(),
                ),
                controls: Mutex::new(Vec::new()),
                blocked: (Mutex::new((false, false)), std::sync::Condvar::new()),
            }
        }

        fn release_blocked(&self) {
            let mut state = self.blocked.0.lock().unwrap();
            state.1 = true;
            self.blocked.1.notify_all();
        }
    }

    impl crate::windows_spooler::WindowsSpooler for PerTargetBlockingSpooler {
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
            unreachable!("control test never submits")
        }

        fn get_job(
            &self,
            printer_name: &str,
            job_id: u32,
        ) -> Result<
            Option<crate::windows_spooler::SpoolJobSnapshot>,
            crate::windows_spooler::SpoolerError,
        > {
            if printer_name == "Blocked Queue" {
                let state = self.blocked.0.lock().unwrap();
                let (mut state, timeout) = self
                    .blocked
                    .1
                    .wait_timeout_while(state, Duration::from_secs(5), |state| !state.1)
                    .unwrap();
                state.0 = true;
                assert!(!timeout.timed_out(), "blocked fake was not released");
            }
            Ok(self
                .snapshots
                .lock()
                .unwrap()
                .get(&(printer_name.to_owned(), job_id))
                .cloned())
        }

        fn enum_jobs(
            &self,
            _printer_name: &str,
        ) -> Result<
            Vec<crate::windows_spooler::SpoolJobSnapshot>,
            crate::windows_spooler::SpoolerError,
        > {
            unreachable!("exact reconciliation uses GetJob")
        }

        fn control_job(
            &self,
            printer_name: &str,
            job_id: u32,
            _control: crate::windows_spooler::SpoolJobControl,
        ) -> Result<(), crate::windows_spooler::SpoolerError> {
            self.controls
                .lock()
                .unwrap()
                .push((printer_name.to_owned(), job_id));
            Ok(())
        }
    }

    #[test]
    fn bulk_native_controls_are_bounded_and_one_target_jam_does_not_block_another() {
        let db = test_file_db();
        let (blocked_marker, fast_marker) = {
            let conn = db.conn.lock().unwrap();
            let blocked_job = insert_control_job(&conn, "dispatched", Some("profile-a"));
            let blocked_attempt =
                add_queued_windows_attempt(&conn, &blocked_job, "Blocked Queue", 73);
            let fast_job = insert_control_job(&conn, "dispatched", Some("profile-b"));
            let fast_attempt = add_queued_windows_attempt(&conn, &fast_job, "Fast Queue", 74);
            (
                crate::print_dispatch::read_attempt(&conn, blocked_attempt)
                    .unwrap()
                    .unwrap()
                    .document_name,
                crate::print_dispatch::read_attempt(&conn, fast_attempt)
                    .unwrap()
                    .unwrap()
                    .document_name,
            )
        };
        let spooler = Arc::new(PerTargetBlockingSpooler::new(vec![
            crate::windows_spooler::SpoolJobSnapshot {
                job_id: 73,
                printer_name: "Blocked Queue".into(),
                document_name: blocked_marker,
                status_text: None,
                status_bits: 0x8,
                position: 1,
                total_pages: 1,
                pages_printed: 0,
            },
            crate::windows_spooler::SpoolJobSnapshot {
                job_id: 74,
                printer_name: "Fast Queue".into(),
                document_name: fast_marker,
                status_text: None,
                status_bits: 0x8,
                position: 1,
                total_pages: 1,
                pages_printed: 0,
            },
        ]));
        let started = std::time::Instant::now();

        let result = pause_and_cancel_pos_jobs_with_spooler(
            &db,
            None,
            spooler.clone(),
            Duration::from_millis(100),
        )
        .unwrap();

        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(result["nativeControlsRequested"], 1);
        assert_eq!(result["nativeControlsConfirmed"], 0);
        assert_eq!(result["nativeControlsFailed"], 1);
        assert_eq!(result["ownershipRefused"], 0);
        assert_eq!(
            spooler.controls.lock().unwrap().as_slice(),
            &[("Fast Queue".to_owned(), 74)]
        );
        spooler.release_blocked();
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            spooler.controls.lock().unwrap().as_slice(),
            &[("Fast Queue".to_owned(), 74)],
            "timed-out ownership query must not issue a late SetJob"
        );
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn profile_pause_persists_before_requesting_only_exact_owned_scoped_windows_jobs() {
        let db = test_file_db();
        let (profile_a_marker, profile_b_marker) = {
            let conn = db.conn.lock().unwrap();
            let profile_a_job = insert_control_job(&conn, "dispatched", Some("profile-a"));
            let profile_a_attempt =
                add_queued_windows_attempt(&conn, &profile_a_job, "Front Queue", 73);
            let profile_b_job = insert_control_job(&conn, "dispatched", Some("profile-b"));
            let profile_b_attempt =
                add_queued_windows_attempt(&conn, &profile_b_job, "Back Queue", 74);
            (
                crate::print_dispatch::read_attempt(&conn, profile_a_attempt)
                    .unwrap()
                    .unwrap()
                    .document_name,
                crate::print_dispatch::read_attempt(&conn, profile_b_attempt)
                    .unwrap()
                    .unwrap()
                    .document_name,
            )
        };
        let spooler = Arc::new(FakeWindowsSpooler::new(73));
        for (job_id, printer_name, document_name) in [
            (73, "Front Queue", profile_a_marker),
            (74, "Back Queue", profile_b_marker),
        ] {
            spooler.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
                job_id,
                printer_name: printer_name.into(),
                document_name,
                status_text: Some("Spooling".into()),
                status_bits: 0x8,
                position: 1,
                total_pages: 1,
                pages_printed: 0,
            });
        }

        let result = set_print_queue_paused_with_spooler(
            &db,
            Some("profile-a"),
            true,
            spooler.clone(),
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(result["nativeControlsRequested"], 1);
        assert_eq!(result["nativeControlsConfirmed"], 0);
        assert_eq!(result["nativeControlsFailed"], 0);
        assert_eq!(result["ownershipRefused"], 0);
        let controls = spooler.controls();
        assert_eq!(controls.len(), 1);
        assert_eq!(controls[0].printer_name, "Front Queue");
        assert_eq!(
            controls[0].control,
            crate::windows_spooler::SpoolJobControl::Pause
        );
        let conn = db.conn.lock().unwrap();
        assert!(is_print_queue_paused_with_conn(&conn, Some("profile-a")));
        assert!(!is_print_queue_paused_with_conn(&conn, Some("profile-b")));
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    struct ApplyingQueueControlSpooler {
        snapshot: Mutex<crate::windows_spooler::SpoolJobSnapshot>,
        controls: Mutex<Vec<crate::windows_spooler::SpoolJobControl>>,
    }

    impl crate::windows_spooler::WindowsSpooler for ApplyingQueueControlSpooler {
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
            unreachable!("queue-control test never submits")
        }

        fn get_job(
            &self,
            printer_name: &str,
            job_id: u32,
        ) -> Result<
            Option<crate::windows_spooler::SpoolJobSnapshot>,
            crate::windows_spooler::SpoolerError,
        > {
            let snapshot = self.snapshot.lock().unwrap().clone();
            Ok(
                (snapshot.printer_name == printer_name && snapshot.job_id == job_id)
                    .then_some(snapshot),
            )
        }

        fn enum_jobs(
            &self,
            _printer_name: &str,
        ) -> Result<
            Vec<crate::windows_spooler::SpoolJobSnapshot>,
            crate::windows_spooler::SpoolerError,
        > {
            unreachable!("queue-control test uses exact GetJob")
        }

        fn control_job(
            &self,
            printer_name: &str,
            job_id: u32,
            control: crate::windows_spooler::SpoolJobControl,
        ) -> Result<(), crate::windows_spooler::SpoolerError> {
            let mut snapshot = self.snapshot.lock().unwrap();
            assert_eq!(snapshot.printer_name, printer_name);
            assert_eq!(snapshot.job_id, job_id);
            snapshot.status_bits = match control {
                crate::windows_spooler::SpoolJobControl::Pause => 0x21,
                crate::windows_spooler::SpoolJobControl::Resume => 0x8,
                crate::windows_spooler::SpoolJobControl::Delete => 0x4,
            };
            self.controls.lock().unwrap().push(control);
            Ok(())
        }
    }

    #[test]
    fn immediate_resume_inspects_exact_active_attempt_after_request_only_pause() {
        let db = test_file_db();
        let marker = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "dispatched", Some("profile-a"));
            let attempt_id = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            crate::print_dispatch::read_attempt(&conn, attempt_id)
                .unwrap()
                .unwrap()
                .document_name
        };
        let spooler = Arc::new(ApplyingQueueControlSpooler {
            snapshot: Mutex::new(crate::windows_spooler::SpoolJobSnapshot {
                job_id: 73,
                printer_name: "Front Queue".into(),
                document_name: marker,
                status_text: Some("Spooling".into()),
                status_bits: 0x8,
                position: 1,
                total_pages: 1,
                pages_printed: 0,
            }),
            controls: Mutex::new(Vec::new()),
        });

        let paused = set_print_queue_paused_with_spooler(
            &db,
            Some("profile-a"),
            true,
            Arc::clone(&spooler),
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(paused["nativeControlsRequested"], 1);
        assert_eq!(
            crate::windows_spooler::map_native_job_status(
                spooler.snapshot.lock().unwrap().status_bits
            ),
            crate::windows_spooler::NativeJobStatus::Offline,
            "the native PAUSED flag can coexist with a higher-severity status"
        );

        let resumed = set_print_queue_paused_with_spooler(
            &db,
            Some("profile-a"),
            false,
            Arc::clone(&spooler),
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(resumed["nativeControlsRequested"], 1);
        assert_eq!(resumed["nativeControlsConfirmed"], 0);
        assert_eq!(
            spooler.controls.lock().unwrap().as_slice(),
            &[
                crate::windows_spooler::SpoolJobControl::Pause,
                crate::windows_spooler::SpoolJobControl::Resume,
            ]
        );
        let conn = db.conn.lock().unwrap();
        assert!(!is_print_queue_paused_with_conn(&conn, Some("profile-a")));
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn paused_worker_still_reconciles_confirmed_absent_windows_cancellation() {
        let db = test_file_db();
        let (job_id, attempt_id, manager) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "dispatched", Some("profile-a"));
            let attempt_id = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            transition_attempt(
                &conn,
                attempt_id,
                DispatchState::CancelRequested,
                AttemptObservation {
                    now: Utc::now(),
                    ..AttemptObservation::default()
                },
            )
            .unwrap();
            db::set_setting(
                &conn,
                PRINT_QUEUE_SETTINGS_CATEGORY,
                PRINT_QUEUE_PAUSED_GLOBAL_KEY,
                "true",
            )
            .unwrap();
            let manager = DispatchManager::hydrate(&conn).unwrap();
            (job_id, attempt_id, manager)
        };
        let data_dir =
            std::env::temp_dir().join(format!("task7-paused-reconcile-{}", Uuid::new_v4()));
        let spooler: Arc<dyn WindowsSpooler> = Arc::new(FakeWindowsSpooler::new(73));

        let outcome = process_pending_jobs_with_adapters_outcome(
            &db,
            &data_dir,
            &manager,
            &CapturingManagedRaw::default(),
            spooler,
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(outcome.processed, 0);
        assert!(outcome.changed);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            crate::print_dispatch::read_attempt(&conn, attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Cancelled
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "cancelled"
        );
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_dir_all(data_dir);
        let _ = std::fs::remove_file(path);
    }

    #[derive(Default)]
    struct BlockingReconciliationState {
        calls: HashMap<String, usize>,
        blocked_started: bool,
        released: bool,
        blocked_returns: usize,
    }

    struct BlockingReconciliationSpooler {
        blocked_target: String,
        state: (Mutex<BlockingReconciliationState>, std::sync::Condvar),
    }

    impl BlockingReconciliationSpooler {
        fn calls_for(&self, target: &str) -> usize {
            self.state
                .0
                .lock()
                .unwrap()
                .calls
                .get(target)
                .copied()
                .unwrap_or(0)
        }

        fn release_blocked(&self) {
            let mut state = self.state.0.lock().unwrap();
            state.released = true;
            self.state.1.notify_all();
        }

        fn wait_for_blocked_start(&self, timeout: Duration) -> bool {
            let state = self.state.0.lock().unwrap();
            let (state, _) = self
                .state
                .1
                .wait_timeout_while(state, timeout, |state| !state.blocked_started)
                .unwrap();
            state.blocked_started
        }

        fn wait_for_blocked_return(&self, timeout: Duration) -> bool {
            let state = self.state.0.lock().unwrap();
            let (state, _) = self
                .state
                .1
                .wait_timeout_while(state, timeout, |state| state.blocked_returns == 0)
                .unwrap();
            state.blocked_returns > 0
        }
    }

    impl crate::windows_spooler::WindowsSpooler for BlockingReconciliationSpooler {
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
            unreachable!("reconciliation test never submits")
        }

        fn get_job(
            &self,
            printer_name: &str,
            _job_id: u32,
        ) -> Result<
            Option<crate::windows_spooler::SpoolJobSnapshot>,
            crate::windows_spooler::SpoolerError,
        > {
            let mut state = self.state.0.lock().unwrap();
            *state.calls.entry(printer_name.to_owned()).or_default() += 1;
            if printer_name == self.blocked_target && !state.released {
                state.blocked_started = true;
                self.state.1.notify_all();
                state = self
                    .state
                    .1
                    .wait_while(state, |state| !state.released)
                    .unwrap();
                state.blocked_returns += 1;
                self.state.1.notify_all();
            }
            Ok(None)
        }

        fn enum_jobs(
            &self,
            _printer_name: &str,
        ) -> Result<
            Vec<crate::windows_spooler::SpoolJobSnapshot>,
            crate::windows_spooler::SpoolerError,
        > {
            unreachable!("reconciliation test uses exact GetJob")
        }

        fn control_job(
            &self,
            _printer_name: &str,
            _job_id: u32,
            _control: crate::windows_spooler::SpoolJobControl,
        ) -> Result<(), crate::windows_spooler::SpoolerError> {
            unreachable!("reconciliation test never controls")
        }
    }

    fn wait_for_native_reconciliation_idle(
        db: &DbState,
        resolved_target: &str,
        timeout: Duration,
    ) -> bool {
        let key = (
            active_print_owner_id(db).unwrap(),
            resolved_target.trim().to_lowercase(),
        );
        let registry = native_reconciliation_registry();
        let in_flight = registry.0.lock().unwrap();
        let (in_flight, _) = registry
            .1
            .wait_timeout_while(in_flight, timeout, |in_flight| in_flight.contains(&key))
            .unwrap();
        !in_flight.contains(&key)
    }

    #[test]
    fn timed_out_reconciliation_coalesces_same_target_until_native_thread_returns() {
        let db = Arc::new(test_file_db());
        let manager = {
            let conn = db.conn.lock().unwrap();
            let blocked_job = insert_control_job(&conn, "dispatched", Some("profile-a"));
            add_queued_windows_attempt(&conn, &blocked_job, "Blocked Queue", 73);
            let fast_job = insert_control_job(&conn, "dispatched", Some("profile-b"));
            add_queued_windows_attempt(&conn, &fast_job, "Fast Queue", 74);
            DispatchManager::hydrate(&conn).unwrap()
        };
        let spooler = Arc::new(BlockingReconciliationSpooler {
            blocked_target: "Blocked Queue".into(),
            state: (
                Mutex::new(BlockingReconciliationState::default()),
                std::sync::Condvar::new(),
            ),
        });

        let first_db = Arc::clone(&db);
        let first_manager = manager.clone();
        let first_spooler = Arc::clone(&spooler);
        let (first_tx, first_rx) = std::sync::mpsc::channel();
        let first_worker = std::thread::spawn(move || {
            // 10s, not 1s: the bound only decides how long we wait before
            // declaring the PERMANENTLY-blocked target failed — the fast
            // target must be given room to actually complete on a loaded CI
            // runner, or it too counts as failed and the coalescing story
            // below asserts the wrong world (seen live: failed=2 on master).
            let result = reconcile_windows_attempts_bounded(
                &first_db,
                &first_manager,
                first_spooler as Arc<dyn WindowsSpooler>,
                Duration::from_secs(10),
            );
            first_tx.send(result).unwrap();
        });
        assert!(
            spooler.wait_for_blocked_start(Duration::from_secs(30)),
            "the fake GetJob must start before the caller-timeout result is asserted"
        );
        let first = first_rx
            .recv_timeout(Duration::from_secs(30))
            .expect("bounded reconciliation caller did not return")
            .unwrap();
        first_worker.join().unwrap();
        assert_eq!(first.failed, 1);
        assert_eq!(first.observed, 1);
        assert_eq!(spooler.calls_for("Blocked Queue"), 1);
        assert_eq!(spooler.calls_for("Fast Queue"), 1);

        let second = reconcile_windows_attempts_bounded(
            &db,
            &manager,
            Arc::clone(&spooler) as Arc<dyn WindowsSpooler>,
            Duration::from_millis(40),
        )
        .unwrap();
        assert_eq!(second, WindowsReconcileCounts::default());
        assert_eq!(
            spooler.calls_for("Blocked Queue"),
            1,
            "same target must not start another GetJob while the timed-out native thread lives"
        );
        assert_eq!(spooler.calls_for("Fast Queue"), 1);

        spooler.release_blocked();
        assert!(spooler.wait_for_blocked_return(Duration::from_secs(30)));
        assert!(wait_for_native_reconciliation_idle(
            &db,
            "Blocked Queue",
            Duration::from_secs(30),
        ));
        let third = reconcile_windows_attempts_bounded(
            &db,
            &manager,
            Arc::clone(&spooler) as Arc<dyn WindowsSpooler>,
            Duration::from_secs(30),
        )
        .unwrap();
        assert_eq!(spooler.calls_for("Blocked Queue"), 2);
        assert_eq!(third.observed, 1);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn resume_is_request_only_and_never_closes_circuit_without_native_observation() {
        let db = test_file_db();
        let (attempt_id, marker) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "dispatched", Some("profile-a"));
            let attempt_id = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            transition_attempt(
                &conn,
                attempt_id,
                DispatchState::Paused,
                AttemptObservation {
                    now: Utc::now(),
                    ..AttemptObservation::default()
                },
            )
            .unwrap();
            db::set_setting(
                &conn,
                PRINT_QUEUE_SETTINGS_CATEGORY,
                &print_queue_pause_key(Some("profile-a")),
                "true",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO print_target_state
                 (target_key, transport, circuit_state, blocked_reason, blocked_at, updated_at)
                 VALUES ('windows:front queue', 'windows', 'open', 'awaiting observation',
                         datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
            let marker = crate::print_dispatch::read_attempt(&conn, attempt_id)
                .unwrap()
                .unwrap()
                .document_name;
            (attempt_id, marker)
        };
        let spooler = Arc::new(FakeWindowsSpooler::new(73));
        spooler.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
            job_id: 73,
            printer_name: "Front Queue".into(),
            document_name: marker,
            status_text: Some("Paused".into()),
            status_bits: 0x1,
            position: 1,
            total_pages: 1,
            pages_printed: 0,
        });

        let result = set_print_queue_paused_with_spooler(
            &db,
            Some("profile-a"),
            false,
            spooler.clone(),
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(result["nativeControlsRequested"], 1);
        assert_eq!(result["nativeControlsConfirmed"], 0);
        assert_eq!(spooler.controls().len(), 1);
        assert_eq!(
            spooler.controls()[0].control,
            crate::windows_spooler::SpoolJobControl::Resume
        );
        let conn = db.conn.lock().unwrap();
        assert!(!is_print_queue_paused_with_conn(&conn, Some("profile-a")));
        assert_eq!(
            crate::print_dispatch::read_attempt(&conn, attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Paused
        );
        assert_eq!(
            conn.query_row(
                "SELECT circuit_state FROM print_target_state
                 WHERE target_key = 'windows:front queue'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "open"
        );
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn typed_queue_snapshot_exposes_only_bounded_operational_metadata() {
        let db = test_db();
        let (job_id, marker) = {
            let conn = db.conn.lock().unwrap();
            insert_managed_windows_profile(&conn, "profile-a", "Front Queue");
            let job_id = insert_control_job(&conn, "dispatched", Some("profile-a"));
            conn.execute(
                "UPDATE print_jobs
                 SET entity_payload_json = ?1,
                     document_snapshot_version = 1,
                     document_snapshot_zlib = ?2,
                     document_snapshot_sha256 = ?3,
                     render_profile_snapshot_json = ?4,
                     output_path = ?5
                 WHERE id = ?6",
                params![
                    r#"{"customer":"QUEUE-PRIVATE-CUSTOMER","logoData":"RAW-LOGO"}"#,
                    b"QUEUE-PRIVATE-SNAPSHOT".as_slice(),
                    "QUEUE-PRIVATE-HASH",
                    r#"{"fixturePayload":"QUEUE-PRIVATE-ENVELOPE"}"#,
                    r#"C:\private\QUEUE-PRIVATE-RECEIPT.html"#,
                    job_id,
                ],
            )
            .unwrap();
            let attempt_id = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            conn.execute(
                "UPDATE print_jobs
                 SET warning_message = 'Queue warning: https://example.invalid/private?token=IPC-WARNING-SECRET',
                     last_error = 'Parent render failed: /srv/private/IPC-PARENT-PATH/receipt.html'
                 WHERE id = ?1",
                [&job_id],
            )
            .unwrap();
            conn.execute(
                "UPDATE print_job_attempts
                 SET last_error = 'Native cancel failed: C:\\private\\IPC-WINDOWS-PATH\\receipt.html api_key=example'
                 WHERE id = ?1",
                [attempt_id.to_string()],
            )
            .unwrap();
            let marker = crate::print_dispatch::read_attempt(&conn, attempt_id)
                .unwrap()
                .unwrap()
                .document_name;
            (job_id, marker)
        };

        let snapshot = print_queue_snapshot(&db, None, None, 20, 0).unwrap();
        let encoded = serde_json::to_string(&snapshot).unwrap();
        let value = serde_json::to_value(snapshot).unwrap();

        assert_eq!(value["jobs"][0]["id"], job_id);
        assert_eq!(value["jobs"][0]["source"], "pos");
        assert_eq!(value["jobs"][0]["transportState"], "windows_queued");
        assert_eq!(
            value["jobs"][0]["printerProfileName"],
            "Managed Windows Printer"
        );
        assert_eq!(value["jobs"][0]["resolvedTransport"], "windows");
        assert_eq!(value["jobs"][0]["resolvedTarget"], "Front Queue");
        assert_eq!(value["jobs"][0]["windowsJobId"], 73);
        assert_eq!(value["jobs"][0]["ownershipMarker"], marker);
        assert_eq!(value["jobs"][0]["snapshotAvailable"], true);
        assert!(value["jobs"][0]
            .as_object()
            .unwrap()
            .contains_key("reprintOfJobId"));
        assert_eq!(value["jobs"][0]["reprintOfJobId"], Value::Null);
        assert_eq!(
            value["jobs"][0]["capabilities"],
            serde_json::json!({
                "cancellable": true,
                "retryable": false,
                "reprintable": false,
            })
        );
        assert_eq!(
            value["jobs"][0]["lastError"],
            "Native cancel failed: [redacted-sensitive-detail]"
        );
        assert_eq!(
            value["jobs"][0]["warningMessage"],
            "Queue warning: [redacted-sensitive-detail]"
        );
        assert_eq!(value["pagination"]["total"], 1);
        assert_eq!(value["pagination"]["hasMore"], false);
        assert_eq!(value["counts"]["active"], 1);
        assert_eq!(value["counts"]["history"], 0);
        for forbidden in [
            "QUEUE-PRIVATE-CUSTOMER",
            "QUEUE-PRIVATE-SNAPSHOT",
            "QUEUE-PRIVATE-HASH",
            "QUEUE-PRIVATE-ENVELOPE",
            "QUEUE-PRIVATE-RECEIPT",
            "RAW-LOGO",
            "IPC-WINDOWS-PATH",
            "IPC-PARENT-PATH",
            "IPC-WARNING-SECRET",
            "example",
            "entityPayloadJson",
            "documentSnapshotZlib",
            "documentSnapshotSha256",
            "renderProfileSnapshotJson",
            "outputPath",
            "logoData",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "leaked {forbidden}: {encoded}"
            );
        }
    }

    #[test]
    fn typed_queue_capabilities_and_reprint_relationship_match_history_rules() {
        let db = test_db();
        let (legacy_source_id, failed_id, expired_id, blocked_id, corrupt_id) = {
            let conn = db.conn.lock().unwrap();

            let legacy_source_id = insert_control_job(&conn, "printed", None);
            insert_receipt_order(&conn, &legacy_source_id, "QUEUE-LEGACY", 4.50);

            let failed_id = insert_control_job(&conn, "failed", None);
            insert_receipt_order(&conn, &failed_id, "QUEUE-FAILED", 5.50);

            let expired_id = insert_control_job(&conn, "printed", None);
            insert_receipt_order(&conn, &expired_id, "QUEUE-EXPIRED", 6.50);

            let blocked_id = insert_control_job(&conn, "failed", None);
            insert_receipt_order(&conn, &blocked_id, "QUEUE-BLOCKED", 7.50);

            let corrupt_id = insert_control_job(&conn, "printed", None);

            for id in [&legacy_source_id, &failed_id, &blocked_id, &corrupt_id] {
                conn.execute(
                    "UPDATE print_jobs
                     SET completed_at = '2026-08-07T12:00:00Z',
                         history_expires_at = '2099-08-07T12:00:00Z'
                     WHERE id = ?1",
                    [id],
                )
                .unwrap();
            }
            conn.execute(
                "UPDATE print_jobs
                 SET completed_at = '2026-01-01T00:00:00Z',
                     history_expires_at = '2026-01-31T00:00:00Z'
                 WHERE id = ?1",
                [&expired_id],
            )
            .unwrap();
            conn.execute(
                "UPDATE print_jobs
                 SET document_snapshot_version = 1,
                     document_snapshot_zlib = ?2,
                     document_snapshot_sha256 = ?3,
                     render_profile_snapshot_json = ?4
                 WHERE id = ?1",
                params![
                    corrupt_id,
                    b"QUEUE-CORRUPT-PRIVATE-BLOB".as_slice(),
                    "QUEUE-CORRUPT-PRIVATE-HASH",
                    r#"{"private":"QUEUE-CORRUPT-PRIVATE-ENVELOPE"}"#,
                ],
            )
            .unwrap();

            conn.execute(
                "INSERT INTO print_job_attempts (
                     id, print_job_id, attempt_number, transport, resolved_target,
                     document_name, spool_job_id, state, started_at
                 ) VALUES (
                     ?1, ?2, 1, 'windows', 'Blocked Queue',
                     'older unresolved attempt', 73, 'unknown', '2026-08-07T12:00:00Z'
                 )",
                params![Uuid::new_v4().to_string(), blocked_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO print_job_attempts (
                     id, print_job_id, attempt_number, transport, resolved_target,
                     document_name, spool_job_id, state, started_at
                 ) VALUES (
                     ?1, ?2, 2, 'windows', 'Blocked Queue',
                     'newer terminal attempt', 74, 'sent',
                     '2026-08-07T12:01:00Z'
                 )",
                params![Uuid::new_v4().to_string(), blocked_id],
            )
            .unwrap();

            (
                legacy_source_id,
                failed_id,
                expired_id,
                blocked_id,
                corrupt_id,
            )
        };

        let cloned = crate::print_history::clone_reprint_job(&db, &legacy_source_id, Utc::now())
            .expect("clone valid legacy history source");
        let child_id = cloned.new_job_id.expect("cloned child id");

        let snapshot = print_queue_snapshot(&db, None, None, 100, 0).unwrap();
        let find = |id: &str| {
            snapshot
                .jobs
                .iter()
                .find(|job| job.id == id)
                .unwrap_or_else(|| panic!("missing queue job {id}"))
        };

        let legacy_source = find(&legacy_source_id);
        assert!(!legacy_source.capabilities.retryable);
        assert!(legacy_source.capabilities.reprintable);

        let failed = find(&failed_id);
        assert!(failed.capabilities.retryable);
        assert!(failed.capabilities.reprintable);

        let expired = find(&expired_id);
        assert!(!expired.capabilities.retryable);
        assert!(!expired.capabilities.reprintable);

        let blocked = find(&blocked_id);
        assert!(!blocked.capabilities.retryable);
        assert!(!blocked.capabilities.reprintable);

        let corrupt = find(&corrupt_id);
        assert!(!corrupt.capabilities.retryable);
        assert!(!corrupt.capabilities.reprintable);

        let child = find(&child_id);
        assert_eq!(
            child.reprint_of_job_id.as_deref(),
            Some(legacy_source_id.as_str())
        );
        assert!(!child.capabilities.retryable);
        assert!(!child.capabilities.reprintable);

        let encoded = serde_json::to_string(&snapshot).unwrap();
        for private in [
            "QUEUE-CORRUPT-PRIVATE-BLOB",
            "QUEUE-CORRUPT-PRIVATE-HASH",
            "QUEUE-CORRUPT-PRIVATE-ENVELOPE",
        ] {
            assert!(!encoded.contains(private), "leaked {private}: {encoded}");
        }
    }

    #[test]
    fn typed_queue_file_reader_releases_global_mutex_and_preserves_history_rules() {
        let db = test_file_db();
        let (legacy_source_id, corrupt_source_id) = {
            let conn = db.conn.lock().unwrap();
            let legacy_source_id = insert_control_job(&conn, "printed", None);
            insert_receipt_order(&conn, &legacy_source_id, "QUEUE-FILE-LEGACY", 4.50);

            let corrupt_source_id = insert_control_job(&conn, "printed", None);
            for id in [&legacy_source_id, &corrupt_source_id] {
                conn.execute(
                    "UPDATE print_jobs
                     SET completed_at = '2026-08-07T12:00:00Z',
                         history_expires_at = '2099-08-07T12:00:00Z'
                     WHERE id = ?1",
                    [id],
                )
                .unwrap();
            }
            conn.execute(
                "UPDATE print_jobs
                 SET document_snapshot_version = 1,
                     document_snapshot_zlib = ?2,
                     document_snapshot_sha256 = ?3,
                     render_profile_snapshot_json = ?4
                 WHERE id = ?1",
                params![
                    corrupt_source_id,
                    b"QUEUE-FILE-CORRUPT-PRIVATE-BLOB".as_slice(),
                    "QUEUE-FILE-CORRUPT-PRIVATE-HASH",
                    r#"{"private":"QUEUE-FILE-CORRUPT-PRIVATE-ENVELOPE"}"#,
                ],
            )
            .unwrap();
            (legacy_source_id, corrupt_source_id)
        };
        let eligibility_calls = AtomicUsize::new(0);

        let snapshot = print_queue_snapshot_with_eligibility_evaluator(
            &db,
            None,
            None,
            100,
            0,
            |reader, job_id, now| {
                let query_only = reader
                    .query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))
                    .expect("inspect queue eligibility reader mode");
                assert_eq!(query_only, 1, "queue eligibility reader must be read-only");
                let global_guard = db
                    .conn
                    .try_lock()
                    .expect("queue capability validation must not hold the global DB mutex");
                drop(global_guard);
                eligibility_calls.fetch_add(1, Ordering::AcqRel);
                crate::print_history::print_history_eligibility(reader, job_id, now)
            },
        )
        .expect("read queue through an independent file database reader");

        let legacy = snapshot
            .jobs
            .iter()
            .find(|job| job.id == legacy_source_id)
            .expect("legacy source row");
        assert!(!legacy.capabilities.retryable);
        assert!(legacy.capabilities.reprintable);

        let corrupt = snapshot
            .jobs
            .iter()
            .find(|job| job.id == corrupt_source_id)
            .expect("corrupt source row");
        assert!(!corrupt.capabilities.retryable);
        assert!(!corrupt.capabilities.reprintable);
        assert_eq!(eligibility_calls.load(Ordering::Acquire), 2);

        let encoded = serde_json::to_string(&snapshot).unwrap();
        for private in [
            "QUEUE-FILE-CORRUPT-PRIVATE-BLOB",
            "QUEUE-FILE-CORRUPT-PRIVATE-HASH",
            "QUEUE-FILE-CORRUPT-PRIVATE-ENVELOPE",
        ] {
            assert!(!encoded.contains(private), "leaked {private}: {encoded}");
        }

        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn typed_queue_file_snapshot_never_waits_for_global_db_mutex() {
        let db = Arc::new(test_file_db());
        {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "failed", None);
            insert_receipt_order(&conn, &job_id, "QUEUE-FILE-NONBLOCKING", 4.50);
            conn.execute(
                "UPDATE print_jobs
                 SET completed_at = '2026-08-07T12:00:00Z',
                     history_expires_at = '2099-08-07T12:00:00Z'
                 WHERE id = ?1",
                [&job_id],
            )
            .unwrap();
        }

        let global_guard = db.conn.lock().unwrap();
        let worker_db = Arc::clone(&db);
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = result_tx.send(print_queue_snapshot(&worker_db, None, None, 20, 0));
        });

        let result_while_mutex_is_held = result_rx.recv_timeout(Duration::from_secs(2));
        drop(global_guard);
        worker.join().expect("queue snapshot worker must not panic");

        let snapshot = result_while_mutex_is_held
            .expect("file-backed queue snapshot must not wait for the global DbState mutex")
            .expect("file-backed queue snapshot");
        assert_eq!(snapshot.jobs.len(), 1);
        assert!(snapshot.jobs[0].capabilities.retryable);
        assert!(snapshot.jobs[0].capabilities.reprintable);

        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn print_history_cache_scope_shares_live_file_identity_but_rejects_same_path_replacement() {
        let first_db = test_file_db();
        let path = first_db.db_path.clone();
        let second_db = {
            let conn = Connection::open(&path).expect("open second live DB handle");
            conn.execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA busy_timeout = 5000;
                 PRAGMA journal_mode = WAL;",
            )
            .expect("configure second live DB handle");
            DbState {
                conn: Mutex::new(conn),
                db_path: path.clone(),
            }
        };
        let first_scope = print_history_validation_scope(&first_db).unwrap();
        assert_eq!(
            first_scope,
            print_history_validation_scope(&second_db).unwrap(),
            "independent readers of one physical DB must share validation hits"
        );
        drop(second_db);
        drop(first_db);

        std::thread::sleep(Duration::from_millis(2));
        let replacement_path = path.with_file_name(format!(
            "the-small-task7-control-replacement-{}-{}.sqlite",
            std::process::id(),
            Uuid::new_v4()
        ));
        {
            let replacement = Connection::open(&replacement_path).expect("create replacement DB");
            replacement
                .execute_batch(
                    "PRAGMA foreign_keys = ON;
                     PRAGMA busy_timeout = 5000;
                     PRAGMA journal_mode = WAL;",
                )
                .expect("configure replacement DB");
            db::run_migrations_for_test(&replacement);
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
        std::fs::rename(&replacement_path, &path).expect("install same-path replacement DB");
        let replacement_db = DbState {
            conn: Mutex::new(Connection::open(&path).expect("open installed replacement DB")),
            db_path: path.clone(),
        };
        assert_ne!(
            first_scope,
            print_history_validation_scope(&replacement_db).unwrap(),
            "a new physical DB at the same path must not reuse validation cache entries"
        );

        drop(replacement_db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
        let _ = std::fs::remove_file(replacement_path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(replacement_path.with_extension("sqlite-shm"));
    }

    #[test]
    fn typed_queue_file_snapshot_keeps_page_counts_settings_and_eligibility_on_one_wal_view() {
        let db = test_file_db();
        let source_id = {
            let conn = db.conn.lock().unwrap();
            let source_id = insert_control_job(&conn, "failed", None);
            insert_receipt_order(&conn, &source_id, "QUEUE-WAL-SOURCE", 4.50);
            conn.execute(
                "UPDATE print_jobs
                 SET completed_at = '2026-08-07T12:00:00Z',
                     history_expires_at = '2099-08-07T12:00:00Z'
                 WHERE id = ?1",
                [&source_id],
            )
            .unwrap();
            source_id
        };
        let path = db.db_path.clone();
        let interleaved = AtomicBool::new(false);

        let snapshot = print_queue_snapshot_with_eligibility_evaluator(
            &db,
            None,
            None,
            100,
            0,
            |reader, job_id, now| {
                if !interleaved.swap(true, Ordering::AcqRel) {
                    let writer = Connection::open(&path).expect("open WAL interleaving writer");
                    writer
                        .execute_batch(
                            "PRAGMA foreign_keys = ON;
                             PRAGMA busy_timeout = 5000;
                             PRAGMA journal_mode = WAL;",
                        )
                        .expect("configure WAL interleaving writer");
                    writer
                        .execute(
                            "UPDATE print_jobs
                             SET status = 'pending', completed_at = NULL,
                                 history_expires_at = NULL, updated_at = datetime('now')
                             WHERE id = ?1",
                            [&source_id],
                        )
                        .expect("mutate source after queue page read");
                    writer
                        .execute("DELETE FROM orders WHERE id = ?1", [&source_id])
                        .expect("remove legacy source after queue page read");
                    db::set_setting(
                        &writer,
                        PRINT_QUEUE_SETTINGS_CATEGORY,
                        PRINT_QUEUE_PAUSED_GLOBAL_KEY,
                        "true",
                    )
                    .expect("pause queue after queue page read");
                    let second_id = insert_control_job(&writer, "failed", None);
                    writer
                        .execute(
                            "UPDATE print_jobs
                             SET completed_at = '2026-08-07T12:00:00Z',
                                 history_expires_at = '2099-08-07T12:00:00Z'
                             WHERE id = ?1",
                            [&second_id],
                        )
                        .expect("make interleaved row visible to a later snapshot");
                }
                crate::print_history::print_history_eligibility(reader, job_id, now)
            },
        )
        .expect("read authoritative WAL queue snapshot");

        assert!(interleaved.load(Ordering::Acquire));
        assert!(
            !snapshot.queue_paused,
            "settings must come from the pre-commit view"
        );
        assert_eq!(snapshot.pagination.total, 1);
        assert_eq!(snapshot.counts.active, 0);
        assert_eq!(snapshot.counts.failed, 1);
        let source = snapshot
            .jobs
            .iter()
            .find(|job| job.id == source_id)
            .expect("pre-commit source row");
        assert_eq!(source.status, "failed");
        assert!(source.capabilities.retryable);
        assert!(source.capabilities.reprintable);

        let later =
            print_queue_snapshot(&db, None, None, 100, 0).expect("read post-commit queue snapshot");
        assert!(later.queue_paused);
        assert_eq!(later.pagination.total, 2);
        assert_eq!(later.counts.active, 1);
        assert_eq!(later.counts.failed, 1);
        let later_source = later
            .jobs
            .iter()
            .find(|job| job.id == source_id)
            .expect("post-commit source row");
        assert_eq!(later_source.status, "pending");
        assert!(!later_source.capabilities.retryable);
        assert!(!later_source.capabilities.reprintable);

        let cleanup_path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(&cleanup_path);
        let _ = std::fs::remove_file(cleanup_path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(cleanup_path.with_extension("sqlite-shm"));
    }

    #[test]
    fn typed_queue_memory_snapshot_restores_query_only_after_success() {
        let db = test_db();
        let source_id = {
            let conn = db.conn.lock().unwrap();
            let source_id = insert_control_job(&conn, "failed", None);
            insert_receipt_order(&conn, &source_id, "QUEUE-MEMORY-SUCCESS", 4.50);
            conn.execute(
                "UPDATE print_jobs
                 SET completed_at = '2026-08-07T12:00:00Z',
                     history_expires_at = '2099-08-07T12:00:00Z'
                 WHERE id = ?1",
                [&source_id],
            )
            .unwrap();
            source_id
        };

        let snapshot = print_queue_snapshot_with_eligibility_evaluator(
            &db,
            None,
            None,
            20,
            0,
            |reader, job_id, now| {
                assert_eq!(
                    reader
                        .query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))
                        .map_err(|error| error.to_string())?,
                    1,
                    "in-memory queue reader must be query-only"
                );
                assert!(
                    !reader.is_autocommit(),
                    "eligibility must share the page/count/settings transaction"
                );
                crate::print_history::print_history_eligibility(reader, job_id, now)
            },
        )
        .expect("read in-memory queue snapshot");
        assert_eq!(snapshot.jobs[0].id, source_id);

        let conn = db.conn.lock().unwrap();
        assert!(
            conn.is_autocommit(),
            "in-memory snapshot transaction must close"
        );
        assert_eq!(
            conn.query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0,
            "in-memory query_only must be restored"
        );
        db::set_setting(&conn, "queue-snapshot-test", "after-success", "write-ok")
            .expect("writes must remain enabled after a successful snapshot");
    }

    #[test]
    fn typed_queue_memory_snapshot_restores_query_only_after_error() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            let source_id = insert_control_job(&conn, "failed", None);
            insert_receipt_order(&conn, &source_id, "QUEUE-MEMORY-ERROR", 4.50);
            conn.execute(
                "UPDATE print_jobs
                 SET completed_at = '2026-08-07T12:00:00Z',
                     history_expires_at = '2099-08-07T12:00:00Z'
                 WHERE id = ?1",
                [&source_id],
            )
            .unwrap();
        }

        let error = print_queue_snapshot_with_eligibility_evaluator(
            &db,
            None,
            None,
            20,
            0,
            |reader, _, _| {
                assert_eq!(
                    reader
                        .query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))
                        .map_err(|error| error.to_string())?,
                    1,
                    "in-memory queue reader must be query-only"
                );
                assert!(
                    !reader.is_autocommit(),
                    "eligibility must share the page/count/settings transaction"
                );
                Err("memory-eligibility-probe".to_string())
            },
        )
        .expect_err("forced eligibility error must propagate");
        assert_eq!(error, "memory-eligibility-probe");

        let conn = db.conn.lock().unwrap();
        assert!(
            conn.is_autocommit(),
            "failed in-memory snapshot must roll back"
        );
        assert_eq!(
            conn.query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0,
            "failed in-memory snapshot must restore query_only"
        );
        db::set_setting(&conn, "queue-snapshot-test", "after-error", "write-ok")
            .expect("writes must remain enabled after a failed snapshot");
    }

    #[test]
    fn operational_error_sanitizer_redacts_sensitive_suffixes_and_bounds_utf8() {
        let jwt_fixture = format!(
            "JWT failed: {}.{}.{}",
            "a".repeat(12),
            "b".repeat(12),
            "c".repeat(12)
        );
        let cases = [
            (
                r"Windows path failed: C:\private\IPC-WINDOWS\receipt.html",
                "IPC-WINDOWS",
            ),
            (
                "Unix path failed: /srv/private/IPC-UNIX/receipt.html",
                "IPC-UNIX",
            ),
            (
                "File URL failed: file:///C:/private/IPC-FILE-URL/receipt.html",
                "IPC-FILE-URL",
            ),
            (
                "HTTP failed: https://user:IPC-URL-PASS@example.invalid/private?token=IPC-QUERY-SECRET",
                "IPC-QUERY-SECRET",
            ),
            (
                "Credential failed: api_key=example",
                "example",
            ),
            (
                "Authorization failed: Bearer IPC-BEARER-SECRET",
                "IPC-BEARER-SECRET",
            ),
            (
                jwt_fixture.as_str(),
                "cccccccccccc",
            ),
        ];

        for (input, forbidden) in cases {
            let sanitized = safe_operational_error(Some(input.to_string()), 96)
                .expect("safe category should remain");
            assert!(
                sanitized.contains("failed:"),
                "lost safe category: {sanitized}"
            );
            assert!(sanitized.contains("[redacted-sensitive-detail]"));
            assert!(
                !sanitized.contains(forbidden),
                "leaked {forbidden}: {sanitized}"
            );
            assert!(sanitized.chars().count() <= 96);
        }

        let utf8 = safe_operational_error(
            Some(format!(
                "{} https://example.invalid/IPC-UTF8",
                "Σ".repeat(200)
            )),
            31,
        )
        .unwrap();
        assert!(utf8.chars().count() <= 31);
        assert!(std::str::from_utf8(utf8.as_bytes()).is_ok());
        assert!(!utf8.contains("IPC-UTF8"));
    }

    #[test]
    fn typed_queue_snapshot_paginates_and_clamps_page_size() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            for _ in 0..3 {
                insert_control_job(&conn, "pending", None);
            }
        }

        let first =
            serde_json::to_value(print_queue_snapshot(&db, None, None, 2, 0).unwrap()).unwrap();
        let second =
            serde_json::to_value(print_queue_snapshot(&db, None, None, 2, 2).unwrap()).unwrap();
        let clamped =
            serde_json::to_value(print_queue_snapshot(&db, None, None, usize::MAX, 0).unwrap())
                .unwrap();

        assert_eq!(first["jobs"].as_array().unwrap().len(), 2);
        assert_eq!(first["pagination"]["total"], 3);
        assert_eq!(first["pagination"]["hasMore"], true);
        assert_eq!(second["jobs"].as_array().unwrap().len(), 1);
        assert_eq!(second["pagination"]["offset"], 2);
        assert_eq!(second["pagination"]["hasMore"], false);
        assert_eq!(clamped["pagination"]["limit"], 100);
    }

    #[test]
    fn failed_parent_with_unknown_windows_blocker_is_active_stale_and_cancellable() {
        let db = test_db();
        let (job_id, attempt_id) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "failed", Some("profile-a"));
            let attempt_id = add_queued_windows_attempt(&conn, &job_id, "Front Queue", 73);
            conn.execute(
                "UPDATE print_job_attempts
                 SET state = 'unknown', last_error = 'native state unresolved'
                 WHERE id = ?1",
                [attempt_id.to_string()],
            )
            .unwrap();
            (job_id, attempt_id)
        };

        let snapshot = print_queue_snapshot(&db, None, None, 50, 0).unwrap();

        let job = snapshot.jobs.iter().find(|job| job.id == job_id).unwrap();
        assert!(job.capabilities.cancellable);
        assert_eq!(snapshot.counts.active, 1);
        assert_eq!(snapshot.counts.failed, 1);
        assert_eq!(snapshot.counts.stale, 1);
        assert_eq!(snapshot.counts.history, 0);

        let plan = durable_pause_and_cancel_pos_jobs(&db, None, Utc::now()).unwrap();
        assert_eq!(plan.affected, 1);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "failed"
        );
        assert_eq!(
            crate::print_dispatch::read_attempt(&conn, attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::CancelRequested
        );
    }

    #[test]
    fn stale_printing_without_attempt_or_live_registry_is_truthfully_unchanged() {
        let db = test_file_db();
        let job_id = {
            let conn = db.conn.lock().unwrap();
            insert_control_job(&conn, "printing", Some("profile-a"))
        };
        let individual = cancel_print_job_with_spooler(
            &db,
            &job_id,
            Arc::new(FakeWindowsSpooler::new(73)),
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(individual["success"], false);
        assert_eq!(individual["affected"], 0);
        assert_eq!(individual["unchanged"], 1);
        assert_eq!(individual["durableChanged"], false);
        assert_eq!(individual["activeStopsRequested"], 0);

        let bulk = pause_and_cancel_pos_jobs_with_spooler(
            &db,
            None,
            Arc::new(FakeWindowsSpooler::new(73)),
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(bulk["affected"], 0);
        assert_eq!(bulk["unchanged"], 1);
        assert_eq!(bulk["activeStopsRequested"], 0);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "printing"
        );
        drop(conn);
        let path = db.db_path.clone();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    fn insert_receipt_order(conn: &Connection, order_id: &str, order_number: &str, total: f64) {
        // W4e Step 0: dual-populate via Cents::round_half_even.
        let total_cents = Cents::round_half_even(total).as_i64();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, ?2, '[]', ?3, ?4, ?3, ?4, 'completed', 'pickup',
                'pending', datetime('now'), datetime('now')
             )",
            params![order_id, order_number, total, total_cents],
        )
        .expect("insert test order");
    }

    fn insert_managed_network_profile(
        conn: &Connection,
        profile_id: &str,
        host: &str,
        port: u16,
        is_default: bool,
    ) {
        conn.execute(
            "INSERT INTO printer_profiles (
                id, name, driver_type, printer_name, printer_type, role,
                is_default, enabled, connection_json, created_at, updated_at
             ) VALUES (
                ?1, 'Managed Test Printer', 'windows', ?2, 'network', 'receipt',
                ?3, 1, ?4, datetime('now'), datetime('now')
             )",
            params![
                profile_id,
                host,
                i64::from(is_default),
                serde_json::json!({"type":"network","ip":host,"port":port}).to_string(),
            ],
        )
        .expect("insert managed test profile");
    }

    fn insert_managed_windows_profile(conn: &Connection, profile_id: &str, queue: &str) {
        conn.execute(
            "INSERT INTO printer_profiles (
                id, name, driver_type, printer_name, printer_type, role,
                is_default, enabled, connection_json, created_at, updated_at
             ) VALUES (
                ?1, 'Managed Windows Printer', 'windows', ?2, 'system', 'receipt',
                1, 1, ?3, datetime('now'), datetime('now')
             )",
            params![
                profile_id,
                queue,
                serde_json::json!({"type":"system","systemName":queue}).to_string(),
            ],
        )
        .expect("insert managed Windows profile");
    }

    fn managed_file_db() -> (Arc<DbState>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("managed-print-db-{}", Uuid::new_v4()));
        let db = db::init(&dir).expect("initialize managed temp database");
        (Arc::new(db), dir)
    }

    struct InspectingManagedRaw {
        calls: AtomicUsize,
    }

    impl ManagedRawTransport for InspectingManagedRaw {
        fn send(
            &self,
            db: &DbState,
            _target: &printers::ResolvedPrinterTarget,
            bytes: &[u8],
            _document_name: &str,
            _cancel: &AtomicBool,
        ) -> Result<printers::RawPrintResult, printers::RawTransportFailure> {
            let conn = db.conn.lock().unwrap();
            let persisted: (i64, String, String) = conn
                .query_row(
                    "SELECT j.document_snapshot_version, a.state, j.status
                     FROM print_jobs j
                     JOIN print_job_attempts a ON a.print_job_id = j.id
                     ORDER BY a.started_at DESC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("snapshot and attempt must be durable before transport");
            assert_eq!(persisted, (1, "submitting".into(), "printing".into()));
            drop(conn);
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(printers::RawPrintResult {
                bytes_requested: bytes.len(),
                bytes_written: bytes.len(),
                doc_name: "managed".into(),
                spool_job_id: None,
            })
        }
    }

    #[derive(Clone, Debug)]
    struct CapturedRawCall {
        target: printers::ResolvedPrinterTarget,
        bytes: Vec<u8>,
    }

    #[derive(Default)]
    struct CapturingManagedRaw {
        calls: Mutex<Vec<CapturedRawCall>>,
    }

    impl ManagedRawTransport for CapturingManagedRaw {
        fn send(
            &self,
            _db: &DbState,
            target: &printers::ResolvedPrinterTarget,
            bytes: &[u8],
            _document_name: &str,
            _cancel: &AtomicBool,
        ) -> Result<printers::RawPrintResult, printers::RawTransportFailure> {
            self.calls.lock().unwrap().push(CapturedRawCall {
                target: target.clone(),
                bytes: bytes.to_vec(),
            });
            Ok(printers::RawPrintResult {
                bytes_requested: bytes.len(),
                bytes_written: bytes.len(),
                doc_name: "managed".into(),
                spool_job_id: None,
            })
        }
    }

    #[derive(Default)]
    struct FakeManagedDrawer {
        calls: Mutex<Vec<FrozenDrawerConfig>>,
        failure: Mutex<Option<String>>,
    }

    impl ManagedDrawerTransport for FakeManagedDrawer {
        fn kick(&self, _db: &DbState, config: &FrozenDrawerConfig) -> Result<(), String> {
            self.calls.lock().unwrap().push(config.clone());
            match self.failure.lock().unwrap().clone() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
    }

    fn prepare_raw_attempt_for_pre_io_guard(
        suffix: &str,
    ) -> (DbState, DispatchManager, FrozenManagedAttempt, String) {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        let order_id = format!("pre-io-order-{suffix}");
        let profile_id = format!("pre-io-profile-{suffix}");
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, &order_id, "PRE-IO", 3.25);
            insert_managed_network_profile(&conn, &profile_id, "guard.local", 9100, true);
            conn.execute(
                "UPDATE printer_profiles
                 SET open_cash_drawer = 1, drawer_mode = 'escpos_tcp',
                     drawer_host = 'drawer.local', drawer_port = 9200
                 WHERE id = ?1",
                [&profile_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', ?2, 'pending', datetime('now'), datetime('now'))",
                params![job_id, order_id],
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();
        let attempt = prepare_frozen_attempt(
            &db,
            &std::env::temp_dir(),
            &manager,
            &job_id,
            "order_receipt",
            &order_id,
            None,
            None,
        )
        .unwrap()
        .expect("prepare managed attempt");
        (db, manager, attempt, profile_id)
    }

    #[test]
    fn managed_global_pause_after_prepare_prevents_transport_io() {
        let (db, manager, attempt, _) = prepare_raw_attempt_for_pre_io_guard("global-pause");
        set_print_queue_paused(&db, None, true).unwrap();
        let raw = CapturingManagedRaw::default();
        let drawer = FakeManagedDrawer::default();

        execute_raw_attempt(&db, &manager, &raw, &drawer, attempt).unwrap();

        assert!(raw.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn managed_profile_pause_after_prepare_prevents_transport_io() {
        let (db, manager, attempt, profile_id) =
            prepare_raw_attempt_for_pre_io_guard("profile-pause");
        set_print_queue_paused(&db, Some(&profile_id), true).unwrap();
        let raw = CapturingManagedRaw::default();
        let drawer = FakeManagedDrawer::default();

        execute_raw_attempt(&db, &manager, &raw, &drawer, attempt).unwrap();

        assert!(raw.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn managed_cancel_after_prepare_prevents_transport_io() {
        let (db, manager, attempt, _) = prepare_raw_attempt_for_pre_io_guard("cancel");
        cancel_print_job(&db, &attempt.identity.local_job_id).unwrap();
        let raw = CapturingManagedRaw::default();
        let drawer = FakeManagedDrawer::default();

        execute_raw_attempt(&db, &manager, &raw, &drawer, attempt).unwrap();

        assert!(raw.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn profile_cancel_after_default_resolution_is_registered_before_preparation_work() {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        let profile_id = "profile-resolution-race";
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "resolution-race-order", "RACE-1", 6.50);
            insert_managed_network_profile(&conn, profile_id, "race.local", 9100, true);
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'resolution-race-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();
        let cancellation = Mutex::new(None);
        let data_dir =
            std::env::temp_dir().join(format!("managed-profile-cancel-{}", Uuid::new_v4()));
        let result = prepare_frozen_attempt_with_profile_hooks(
            &db,
            &data_dir,
            &manager,
            &job_id,
            "order_receipt",
            "resolution-race-order",
            None,
            None,
            &|resolved_profile_id| {
                assert_eq!(resolved_profile_id, profile_id);
                assert!(matches!(
                    profile_association_coordination().try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ));
            },
            &|resolved_profile_id| {
                assert_eq!(resolved_profile_id, profile_id);
                let parent_profile: Option<String> = db
                    .conn
                    .lock()
                    .unwrap()
                    .query_row(
                        "SELECT printer_profile_id FROM print_jobs WHERE id = ?1",
                        [&job_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(parent_profile, None);
                *cancellation.lock().unwrap() =
                    Some(pause_and_cancel_pos_jobs(&db, Some(profile_id), None).unwrap());
            },
        );

        let cancellation = cancellation.lock().unwrap().take().unwrap();
        assert_eq!(cancellation["affected"], 1);
        assert_eq!(cancellation["activeStopsRequested"], 1);
        assert!(matches!(result, Ok(None)));
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "cancelled"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        drop(conn);
        assert!(!data_dir.join(RECEIPTS_DIR).exists());
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn managed_success_uses_frozen_drawer_config_after_profile_mutation() {
        let (db, manager, attempt, profile_id) =
            prepare_raw_attempt_for_pre_io_guard("frozen-drawer");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE printer_profiles
                 SET open_cash_drawer = 0, drawer_mode = 'none',
                     drawer_host = 'mutated.local', drawer_port = 9999
                 WHERE id = ?1",
                [&profile_id],
            )
            .unwrap();
        }
        let raw = CapturingManagedRaw::default();
        let drawer = FakeManagedDrawer::default();

        execute_raw_attempt(&db, &manager, &raw, &drawer, attempt).unwrap();

        let calls = drawer.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].enabled);
        assert_eq!(calls[0].mode, "escpos_tcp");
        assert_eq!(calls[0].host.as_deref(), Some("drawer.local"));
        assert_eq!(calls[0].port, 9200);
    }

    #[test]
    fn disabled_drawer_ignores_stale_tcp_configuration_and_is_not_called() {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        let data_dir =
            std::env::temp_dir().join(format!("managed-disabled-drawer-{}", Uuid::new_v4()));
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "disabled-drawer-order", "DD-1", 4.0);
            insert_managed_network_profile(
                &conn,
                "disabled-drawer-profile",
                "disabled-drawer.local",
                9100,
                true,
            );
            conn.execute(
                "UPDATE printer_profiles
                 SET open_cash_drawer = 0, drawer_mode = 'escpos_tcp', drawer_host = NULL,
                     drawer_port = 0
                 WHERE id = 'disabled-drawer-profile'",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'disabled-drawer-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();
        let attempt = prepare_frozen_attempt(
            &db,
            &data_dir,
            &manager,
            &job_id,
            "order_receipt",
            "disabled-drawer-order",
            None,
            None,
        )
        .expect("disabled stale drawer configuration must validate")
        .expect("prepare managed attempt");
        let raw = CapturingManagedRaw::default();
        let drawer = FakeManagedDrawer::default();

        execute_raw_attempt(&db, &manager, &raw, &drawer, attempt).unwrap();

        assert_eq!(raw.calls.lock().unwrap().len(), 1);
        assert!(drawer.calls.lock().unwrap().is_empty());
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT status FROM print_jobs WHERE id = ?1",
                    [&job_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "dispatched"
        );
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn managed_windows_acceptance_uses_frozen_drawer_config() {
        let (db, db_dir) = managed_file_db();
        let job_id = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "windows-drawer-order", "WD-1", 4.0);
            insert_managed_windows_profile(&conn, "windows-drawer-profile", "Drawer Queue");
            conn.execute(
                "UPDATE printer_profiles
                 SET open_cash_drawer = 1, drawer_mode = 'escpos_tcp',
                     drawer_host = 'frozen-drawer.local', drawer_port = 9300
                 WHERE id = 'windows-drawer-profile'",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'windows-drawer-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();
        let attempt = prepare_frozen_attempt(
            &db,
            &db_dir.join("output"),
            &manager,
            &job_id,
            "order_receipt",
            "windows-drawer-order",
            None,
            None,
        )
        .unwrap()
        .expect("prepare Windows managed attempt");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE printer_profiles
                 SET open_cash_drawer = 0, drawer_mode = 'none',
                     drawer_host = 'mutated.local', drawer_port = 9999
                 WHERE id = 'windows-drawer-profile'",
                [],
            )
            .unwrap();
        }
        let drawer = FakeManagedDrawer::default();

        execute_windows_attempt(
            &db,
            &manager,
            Arc::new(FakeWindowsSpooler::new(93)),
            &drawer,
            Duration::from_secs(5),
            attempt,
        )
        .unwrap();

        let calls = drawer.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].enabled);
        assert_eq!(calls[0].mode, "escpos_tcp");
        assert_eq!(calls[0].host.as_deref(), Some("frozen-drawer.local"));
        assert_eq!(calls[0].port, 9300);
    }

    #[test]
    fn managed_drawer_failure_is_nonfatal_and_persists_warning() {
        let (db, manager, attempt, _) = prepare_raw_attempt_for_pre_io_guard("drawer-warning");
        let job_id = attempt.identity.local_job_id.clone();
        let raw = CapturingManagedRaw::default();
        let drawer = FakeManagedDrawer::default();
        *drawer.failure.lock().unwrap() = Some("simulated drawer failure".into());

        execute_raw_attempt(&db, &manager, &raw, &drawer, attempt).unwrap();

        let conn = db.conn.lock().unwrap();
        let result: (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT status, warning_code, warning_message FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(result.0, "dispatched");
        assert_eq!(result.1.as_deref(), Some("drawer_kick_failed"));
        assert!(result.2.unwrap().contains("simulated drawer failure"));
    }

    #[test]
    fn managed_render_warning_survives_successful_dispatch() {
        let (db, manager, mut attempt, _) = prepare_raw_attempt_for_pre_io_guard("render-warning");
        let job_id = attempt.identity.local_job_id.clone();
        attempt.warning_codes = vec!["logo_text_fallback".into()];

        execute_raw_attempt(
            &db,
            &manager,
            &CapturingManagedRaw::default(),
            &FakeManagedDrawer::default(),
            attempt,
        )
        .unwrap();

        let conn = db.conn.lock().unwrap();
        let warning: (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT warning_code, warning_message FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(warning.0.as_deref(), Some("render_warning"));
        assert!(warning.1.unwrap().contains("logo_text_fallback"));
    }

    fn frozen_envelope_value(db: &DbState, job_id: &str) -> Value {
        let conn = db.conn.lock().unwrap();
        let raw: String = conn
            .query_row(
                "SELECT render_profile_snapshot_json FROM print_jobs WHERE id = ?1",
                [job_id],
                |row| row.get(0),
            )
            .expect("persisted frozen render envelope");
        serde_json::from_str(&raw).expect("valid frozen render envelope JSON")
    }

    #[test]
    fn managed_snapshot_audits_all_effective_layout_controls() {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "audit-order", "AUDIT-1", 12.5);
            insert_managed_network_profile(&conn, "audit-profile", "Epson-TM.local", 9100, true);
            conn.execute(
                "UPDATE printer_profiles
                 SET paper_width_mm = 58, cut_paper = 0,
                     character_set = 'CP737_GREEK', greek_render_mode = 'raster',
                     receipt_template = 'classic', escpos_code_page = 66,
                     font_type = 'b', layout_density = 'spacious', header_emphasis = 'normal',
                     connection_json = ?1
                 WHERE id = 'audit-profile'",
                [serde_json::json!({
                    "type": "network",
                    "ip": "Epson-TM.local",
                    "port": 9100,
                    "render_mode": "text",
                    "emulation": "escpos",
                    "printable_width_dots": 320,
                    "left_margin_dots": 12,
                    "threshold": 145
                })
                .to_string()],
            )
            .unwrap();
            for (category, key, value) in [
                ("receipt", "command_profile", "safe_text"),
                ("receipt", "layout_density_scale", "1.2"),
                ("receipt", "text_scale", "1.6"),
                ("receipt", "logo_scale", "1.4"),
                ("receipt", "body_boldness", "4"),
                ("receipt", "classic_customer_render_mode", "text"),
                ("general", "language", "el"),
                ("organization", "name", "Audit Organization"),
                ("restaurant", "subtitle", "Audit Branch"),
                ("restaurant", "address", "1 Audit Street"),
                ("restaurant", "phone", "+30 210 000 0000"),
                ("organization", "vat_number", "EL123"),
                ("organization", "tax_office", "Athens"),
                ("receipt", "footer_text", "Audit footer"),
                ("receipt", "show_qr_code", "true"),
                ("receipt", "qr_url", "https://example.invalid/audit"),
                ("receipt", "copy_label", "DUPLICATE"),
                ("receipt", "currency_symbol", " EUR"),
            ] {
                db::set_setting(&conn, category, key, value).unwrap();
            }
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'audit-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();
        let attempt = prepare_frozen_attempt(
            &db,
            &std::env::temp_dir(),
            &manager,
            &job_id,
            "order_receipt",
            "audit-order",
            None,
            None,
        )
        .unwrap()
        .expect("prepare audited managed attempt");
        drop(attempt);

        let envelope = frozen_envelope_value(&db, &job_id);
        assert_eq!(envelope["paper_width_mm"], 58);
        assert_eq!(envelope["command_profile"], "safe_text");
        assert_eq!(envelope["greek_render_mode"], "raster");
        assert_eq!(envelope["layout_density_scale"], 1.2);
        assert_eq!(envelope["text_scale"], 1.6);
        assert_eq!(envelope["classic_customer_render_mode"], "text");
        assert_eq!(envelope["raster_threshold"], 145);
        assert_eq!(envelope["body_font_weight"], 700);
        assert_eq!(envelope["printable_width_dots"], 320);
        assert_eq!(envelope["left_margin_dots"], 12);
        assert_eq!(envelope["decimal_comma"], true);
        assert_eq!(envelope["language"], "el");
        assert_eq!(envelope["detected_brand"], "epson");
        assert_eq!(envelope["organization_name"], "Audit Organization");
        assert_eq!(envelope["store_subtitle"], "Audit Branch");
        assert_eq!(envelope["store_address"], "1 Audit Street");
        assert_eq!(envelope["store_phone"], "+30 210 000 0000");
        assert_eq!(envelope["vat_number"], "EL123");
        assert_eq!(envelope["tax_office"], "Athens");
        assert_eq!(envelope["footer_text"], "Audit footer");
        assert_eq!(envelope["show_qr_code"], true);
        assert_eq!(envelope["qr_configured"], true);
        assert_eq!(envelope["copy_label"], "DUPLICATE");
        assert_eq!(envelope["currency_symbol"], "EUR");
        assert_eq!(envelope["cut_paper"], false);
    }

    #[test]
    fn managed_snapshot_distinguishes_configured_logo_from_actual_inclusion() {
        let (db, db_dir) = managed_file_db();
        let job_id = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "logo-audit-order", "LOGO-1", 8.0);
            insert_managed_windows_profile(&conn, "logo-audit-profile", "Epson TM-T88V");
            db::set_setting(&conn, "receipt", "show_logo", "true").unwrap();
            db::set_setting(
                &conn,
                "receipt",
                "logo_source",
                "data:image/png;base64,definitely-not-an-image",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'logo-audit-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();
        let attempt = prepare_frozen_attempt(
            &db,
            &db_dir.join("output"),
            &manager,
            &job_id,
            "order_receipt",
            "logo-audit-order",
            None,
            None,
        )
        .unwrap()
        .expect("prepare logo audit attempt");
        drop(attempt);

        let envelope = frozen_envelope_value(&db, &job_id);
        assert_eq!(envelope["logo_enabled"], true);
        assert_eq!(envelope["logo_configured"], true);
        assert_eq!(envelope["logo_included"], false);
        assert!(envelope["warning_codes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "logo_text_fallback"));
    }

    #[test]
    fn managed_snapshot_marks_nonempty_generated_logo_prefix_as_included() {
        let (db, db_dir) = managed_file_db();
        let job_id = Uuid::new_v4().to_string();
        let mut encoded_logo = Vec::new();
        image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(4, 4, image::Luma([0])))
            .write_to(
                &mut std::io::Cursor::new(&mut encoded_logo),
                image::ImageFormat::Png,
            )
            .unwrap();
        let logo_source = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded_logo)
        );
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "logo-prefix-order", "LOGO-2", 8.0);
            insert_managed_windows_profile(&conn, "logo-prefix-profile", "Epson TM-T88V");
            db::set_setting(&conn, "receipt", "classic_customer_render_mode", "text").unwrap();
            db::set_setting(&conn, "receipt", "show_logo", "true").unwrap();
            db::set_setting(&conn, "receipt", "logo_source", &logo_source).unwrap();
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'logo-prefix-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();
        let attempt = prepare_frozen_attempt(
            &db,
            &db_dir.join("output"),
            &manager,
            &job_id,
            "order_receipt",
            "logo-prefix-order",
            None,
            None,
        )
        .unwrap()
        .expect("prepare generated logo prefix attempt");
        drop(attempt);

        let envelope = frozen_envelope_value(&db, &job_id);
        assert_eq!(envelope["logo_enabled"], true);
        assert_eq!(envelope["logo_configured"], true);
        assert_eq!(envelope["logo_included"], true);
        assert!(!envelope["warning_codes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "logo_text_fallback"));
    }

    #[test]
    fn managed_frozen_envelope_rejects_invalid_layout_bounds() {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "bounds-order", "BOUNDS-1", 5.0);
            insert_managed_network_profile(&conn, "bounds-profile", "bounds.local", 9100, true);
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'bounds-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();
        let attempt = prepare_frozen_attempt(
            &db,
            &std::env::temp_dir(),
            &manager,
            &job_id,
            "order_receipt",
            "bounds-order",
            None,
            None,
        )
        .unwrap()
        .expect("prepare bounds audit attempt");
        drop(attempt);
        let original = frozen_envelope_value(&db, &job_id);

        for (field, invalid) in [
            ("printable_width_dots", serde_json::json!(0)),
            ("raster_threshold", serde_json::json!(0)),
            ("layout_density_scale", serde_json::json!(0.1)),
            ("text_scale", serde_json::json!(0.1)),
            ("logo_scale", serde_json::json!(5.0)),
            ("body_font_weight", serde_json::json!(399)),
        ] {
            let mut candidate = original.clone();
            candidate[field] = invalid;
            let parsed: FrozenRenderEnvelope = serde_json::from_value(candidate).unwrap();
            assert!(
                parsed.validate("order_receipt").is_err(),
                "invalid {field} must be rejected"
            );
        }
    }

    #[test]
    fn managed_preparation_rejects_invalid_fresh_envelope_before_snapshot_or_attempt() {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        let data_dir =
            std::env::temp_dir().join(format!("managed-invalid-envelope-{}", Uuid::new_v4()));
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "invalid-envelope-order", "INVALID-1", 5.0);
            insert_managed_network_profile(
                &conn,
                "invalid-envelope-profile",
                "invalid.local",
                9100,
                true,
            );
            conn.execute(
                "UPDATE printer_profiles
                 SET open_cash_drawer = 1, drawer_mode = 'escpos_tcp', drawer_host = NULL
                 WHERE id = 'invalid-envelope-profile'",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'invalid-envelope-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();

        let result = prepare_frozen_attempt(
            &db,
            &data_dir,
            &manager,
            &job_id,
            "order_receipt",
            "invalid-envelope-order",
            None,
            None,
        );

        assert!(result.is_err(), "invalid fresh envelope must be rejected");
        assert!(result
            .err()
            .unwrap()
            .contains("Frozen drawer TCP configuration has no host"));
        let conn = db.conn.lock().unwrap();
        assert_parent_has_no_managed_preparation_effects(&conn, &job_id);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        drop(conn);
        assert!(!data_dir.join(RECEIPTS_DIR).exists());
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn managed_busy_target_has_no_parent_snapshot_attempt_or_artifact_effects() {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        let data_dir =
            std::env::temp_dir().join(format!("managed-busy-effects-{}", Uuid::new_v4()));
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "busy-effects-order", "BUSY-1", 5.0);
            insert_managed_network_profile(
                &conn,
                "busy-effects-profile",
                "busy-effects.local",
                9100,
                true,
            );
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'busy-effects-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();
        let mut held = manager
            .claim(PrinterTargetKey::RawTcp {
                host: "busy-effects.local".into(),
                port: 9100,
            })
            .unwrap();

        let result = prepare_frozen_attempt(
            &db,
            &data_dir,
            &manager,
            &job_id,
            "order_receipt",
            "busy-effects-order",
            None,
            None,
        )
        .unwrap();

        assert!(result.is_none());
        let conn = db.conn.lock().unwrap();
        assert_parent_has_no_managed_preparation_effects(&conn, &job_id);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        drop(conn);
        assert!(!data_dir.join(RECEIPTS_DIR).exists());
        held.release_unstarted();
        drop(held);
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn managed_attempt_transaction_failure_rolls_back_and_cleans_provisional_artifact() {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        let data_dir = std::env::temp_dir().join(format!("managed-tx-cleanup-{}", Uuid::new_v4()));
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "tx-cleanup-order", "TX-1", 7.0);
            insert_managed_network_profile(
                &conn,
                "tx-cleanup-profile",
                "tx-cleanup.local",
                9100,
                true,
            );
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'tx-cleanup-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
            conn.execute_batch(
                "CREATE TRIGGER fail_managed_attempt_insert
                 BEFORE INSERT ON print_job_attempts
                 BEGIN
                     SELECT RAISE(FAIL, 'injected attempt insert failure');
                 END;",
            )
            .unwrap();
        }
        let manager = DispatchManager::isolated_for_test();

        let result = prepare_frozen_attempt(
            &db,
            &data_dir,
            &manager,
            &job_id,
            "order_receipt",
            "tx-cleanup-order",
            None,
            None,
        );

        assert!(result.is_err());
        let conn = db.conn.lock().unwrap();
        assert_parent_has_no_managed_preparation_effects(&conn, &job_id);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        drop(conn);
        assert!(!data_dir.join(RECEIPTS_DIR).exists());
        let mut retry_lease = manager
            .claim(PrinterTargetKey::RawTcp {
                host: "tx-cleanup.local".into(),
                port: 9100,
            })
            .expect("transaction failure must release the unstarted lane");
        retry_lease.release_unstarted();
        drop(retry_lease);
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn claim_loser_cleanup_failure_does_not_mutate_concurrent_winner_parent_or_attempt() {
        let db = Arc::new(test_db());
        let manager = Arc::new(DispatchManager::isolated_for_test());
        let job_id = Uuid::new_v4().to_string();
        let data_dir = std::env::temp_dir().join(format!("managed-claim-lost-{}", Uuid::new_v4()));
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "claim-lost-order", "CL-1", 8.0);
            insert_managed_network_profile(
                &conn,
                "claim-lost-profile",
                "claim-lost.local",
                9100,
                true,
            );
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'claim-lost-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let (artifact_ready_tx, artifact_ready_rx) = std::sync::mpsc::channel();
        let (loser_release_tx, loser_release_rx) = std::sync::mpsc::channel();
        let loser_db = Arc::clone(&db);
        let loser_manager = Arc::clone(&manager);
        let loser_job_id = job_id.clone();
        let loser_data_dir = data_dir.clone();
        let loser = std::thread::spawn(move || {
            prepare_frozen_attempt_with_hooks(
                &loser_db,
                &loser_data_dir,
                &loser_manager,
                &loser_job_id,
                "order_receipt",
                "claim-lost-order",
                None,
                None,
                &|_| {},
                &|_| {},
                &|path| {
                    artifact_ready_tx.send(path.to_path_buf()).unwrap();
                    loser_release_rx.recv().unwrap();
                },
            )
        });
        let artifact_path = artifact_ready_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        let artifact_ref = artifact_path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.rsplit('_').next())
            .expect("artifact filename should end in a safe UUID")
            .to_string();
        assert!(Uuid::parse_str(&artifact_ref).is_ok());

        let winner = crate::print_dispatch::prepare_managed_attempt(
            &db.conn.lock().unwrap(),
            PrepareManagedAttempt {
                local_job_id: job_id.clone(),
                printer_profile_id: "claim-lost-profile".into(),
                target: PrinterTargetKey::RawTcp {
                    host: "claim-lost.local".into(),
                    port: 9100,
                },
                document_kind: "order_receipt".into(),
                payload: vec![0x1b, 0x40],
                render_profile_snapshot_json: r#"{"winner":true}"#.into(),
                now: Utc::now(),
            },
        )
        .unwrap();
        std::fs::remove_file(&artifact_path).unwrap();
        std::fs::create_dir(&artifact_path).unwrap();
        loser_release_tx.send(()).unwrap();

        let error = match loser.join().unwrap() {
            Err(error) => error,
            Ok(_) => panic!("claim loser unexpectedly prepared an attempt"),
        };
        assert!(matches!(
            &error,
            ManagedPreparationFailure::ClaimLostCleanup(message)
                if message.contains(&format!("artifact_ref={artifact_ref}"))
                    && !message.contains(artifact_path.to_string_lossy().as_ref())
        ));
        handle_managed_preparation_failure(&db, &job_id, &error);

        let conn = db.conn.lock().unwrap();
        let parent: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, last_error FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(parent, ("printing".into(), 0, None));
        let attempt: (String, String) = conn
            .query_row(
                "SELECT id, state FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(attempt, (winner.attempt_id.to_string(), "created".into()));
        drop(conn);
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn managed_worker_persists_snapshot_and_attempt_before_any_transport_call() {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "managed-order", "M-1", 12.50);
            insert_managed_network_profile(&conn, "profile-default", "printer.local", 9100, true);
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'managed-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let data_dir = std::env::temp_dir().join(format!("managed-print-{}", Uuid::new_v4()));
        let raw = InspectingManagedRaw {
            calls: AtomicUsize::new(0),
        };
        let spooler: Arc<dyn WindowsSpooler> = Arc::new(FakeWindowsSpooler::new(73));
        let manager = DispatchManager::isolated_for_test();

        let processed = process_pending_jobs_with_adapters(
            &db,
            &data_dir,
            &manager,
            &raw,
            spooler,
            Duration::from_secs(1),
        )
        .expect("managed worker");
        assert_eq!(processed, 1);
        assert_eq!(raw.calls.load(Ordering::SeqCst), 1);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "dispatched"
        );
        assert_eq!(
            conn.query_row(
                "SELECT state FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            DispatchState::Sent.as_str()
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn managed_worker_uses_frozen_bytes_and_target_after_profile_or_entity_mutates() {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "frozen-order", "F-1", 12.50);
            insert_managed_network_profile(&conn, "frozen-profile", "original.local", 9100, true);
            conn.execute(
                "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'frozen-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            ).unwrap();
        }
        let data_dir = std::env::temp_dir().join(format!("managed-frozen-{}", Uuid::new_v4()));
        let raw = CapturingManagedRaw::default();
        let spooler: Arc<dyn WindowsSpooler> = Arc::new(FakeWindowsSpooler::new(73));
        let manager = DispatchManager::isolated_for_test();
        process_pending_jobs_with_adapters(
            &db,
            &data_dir,
            &manager,
            &raw,
            Arc::clone(&spooler),
            Duration::from_secs(1),
        )
        .unwrap();
        let first = raw.calls.lock().unwrap()[0].clone();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE orders SET total_amount = 999, total_amount_cents = 99900 WHERE id = 'frozen-order'", []).unwrap();
            conn.execute(
                "UPDATE printer_profiles
                 SET printer_name = 'mutated.local',
                     connection_json = '{\"type\":\"network\",\"ip\":\"mutated.local\",\"port\":9200}'
                 WHERE id = 'frozen-profile'",
                [],
            ).unwrap();
            conn.execute(
                "UPDATE print_jobs SET status = 'pending', next_retry_at = NULL WHERE id = ?1",
                [&job_id],
            )
            .unwrap();
        }
        process_pending_jobs_with_adapters(
            &db,
            &data_dir,
            &manager,
            &raw,
            spooler,
            Duration::from_secs(1),
        )
        .unwrap();
        let calls = raw.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].bytes, first.bytes);
        assert_eq!(calls[1].target, first.target);
        assert_eq!(
            calls[1].target,
            printers::ResolvedPrinterTarget::RawTcp {
                host: "original.local".into(),
                port: 9100
            }
        );
        drop(calls);
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn managed_reprint_replays_frozen_checkout_and_z_report_after_live_data_and_target_mutate() {
        fn insert_financial_entity_fixture(conn: &Connection, entity_type: &str, entity_id: &str) {
            match entity_type {
                "shift_checkout" => {
                    insert_shift_checkout_fixture(conn, entity_id, "terminal-1");
                }
                "z_report" => {
                    let shift_id = format!("{entity_id}-shift");
                    insert_shift_checkout_fixture(conn, &shift_id, "terminal-1");
                    let report_json = serde_json::json!({
                        "terminalName": "Original Z Terminal",
                        "shifts": { "total": 1 },
                        "cashDrawer": {
                            "openingTotal": 100.0,
                            "cashSales": 25.0,
                            "expected": 125.0,
                            "moneyInDrawer": 125.0,
                            "totalVariance": 0.0
                        }
                    })
                    .to_string();
                    conn.execute(
                        "INSERT INTO z_reports (
                             id, shift_id, branch_id, terminal_id, report_date, generated_at,
                             gross_sales, net_sales, total_orders, cash_sales, card_sales,
                             tips_total, cash_variance, opening_cash, closing_cash, expected_cash,
                             report_json, created_at, updated_at
                         ) VALUES (
                             ?1, ?2, 'branch-1', 'terminal-1', '2026-03-15',
                             '2026-03-15T23:59:00Z', 25.0, 25.0, 3, 15.0, 10.0,
                             0.0, 0.0, 100.0, 125.0, 125.0, ?3,
                             '2026-03-15T23:59:00Z', '2026-03-15T23:59:00Z'
                         )",
                        params![entity_id, shift_id, report_json],
                    )
                    .expect("insert frozen Z-report fixture");
                }
                unexpected => panic!("unexpected financial entity type: {unexpected}"),
            }
        }

        fn mutate_financial_entity_fixture(conn: &Connection, entity_type: &str, entity_id: &str) {
            let affected = match entity_type {
                "shift_checkout" => conn.execute(
                    "UPDATE staff_shifts
                     SET staff_name = 'Mutated Cashier',
                         total_sales_amount = 987.65,
                         total_sales_amount_cents = 98765,
                         closing_cash_amount = 876.54,
                         closing_cash_amount_cents = 87654,
                         expected_cash_amount = 765.43,
                         expected_cash_amount_cents = 76543,
                         updated_at = '2099-12-31T23:59:00Z'
                     WHERE id = ?1",
                    [entity_id],
                ),
                "z_report" => {
                    let report_json = serde_json::json!({
                        "terminalName": "Mutated Z Terminal",
                        "shifts": { "total": 1 },
                        "cashDrawer": {
                            "openingTotal": 900.0,
                            "cashSales": 99.0,
                            "expected": 999.0,
                            "moneyInDrawer": 998.0,
                            "totalVariance": -1.0
                        }
                    })
                    .to_string();
                    conn.execute(
                        "UPDATE z_reports
                         SET report_date = '2099-12-31',
                             generated_at = '2099-12-31T23:59:00Z',
                             gross_sales = 999.0,
                             net_sales = 999.0,
                             total_orders = 99,
                             cash_sales = 99.0,
                             card_sales = 900.0,
                             opening_cash = 900.0,
                             closing_cash = 998.0,
                             expected_cash = 999.0,
                             report_json = ?2,
                             updated_at = '2099-12-31T23:59:00Z'
                         WHERE id = ?1",
                        params![entity_id, report_json],
                    )
                }
                unexpected => panic!("unexpected financial entity type: {unexpected}"),
            }
            .expect("mutate live financial print source");
            assert_eq!(affected, 1, "{entity_type} fixture must mutate one row");
        }

        for (entity_type, entity_id, case_name) in [
            ("shift_checkout", "history-shift", "shift"),
            ("z_report", "history-z", "z"),
        ] {
            let db = test_db();
            let source_job_id = Uuid::new_v4().to_string();
            let control_job_id = Uuid::new_v4().to_string();
            let profile_id = format!("{case_name}-history-profile");
            let original_host = format!("original-{case_name}.local");
            let mutated_host = format!("mutated-{case_name}.local");
            {
                let conn = db.conn.lock().unwrap();
                insert_managed_network_profile(&conn, &profile_id, &original_host, 9100, true);
                let original_connection = serde_json::json!({
                    "type": "network",
                    "ip": original_host,
                    "port": 9100,
                    "render_mode": "text"
                })
                .to_string();
                conn.execute(
                    "UPDATE printer_profiles SET connection_json = ?1 WHERE id = ?2",
                    params![original_connection, profile_id],
                )
                .expect("select fast deterministic text rendering for financial history proof");
                insert_financial_entity_fixture(&conn, entity_type, entity_id);
                conn.execute(
                    "INSERT INTO print_jobs (
                         id, entity_type, entity_id, printer_profile_id,
                         status, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, 'pending', datetime('now'), datetime('now'))",
                    params![source_job_id, entity_type, entity_id, profile_id],
                )
                .expect("insert original financial print job");
            }

            let data_dir = std::env::temp_dir().join(format!(
                "managed-financial-reprint-{case_name}-{}",
                Uuid::new_v4()
            ));
            let raw = CapturingManagedRaw::default();
            let spooler: Arc<dyn WindowsSpooler> = Arc::new(FakeWindowsSpooler::new(73));
            let manager = DispatchManager::isolated_for_test();

            assert_eq!(
                process_pending_jobs_with_adapters(
                    &db,
                    &data_dir,
                    &manager,
                    &raw,
                    Arc::clone(&spooler),
                    Duration::from_secs(1),
                )
                .expect("dispatch original financial document"),
                1
            );
            {
                let conn = db.conn.lock().unwrap();
                let source: (String, bool, bool, Option<String>) = conn
                    .query_row(
                        "SELECT status,
                                document_snapshot_version IS NOT NULL
                                AND document_snapshot_zlib IS NOT NULL
                                AND document_snapshot_sha256 IS NOT NULL
                                AND render_profile_snapshot_json IS NOT NULL,
                                history_expires_at IS NOT NULL,
                                last_error
                         FROM print_jobs WHERE id = ?1",
                        [&source_job_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .expect("read frozen financial source");
                assert_eq!(source, ("dispatched".into(), true, true, None));

                mutate_financial_entity_fixture(&conn, entity_type, entity_id);
                let mutated_connection = serde_json::json!({
                    "type": "network",
                    "ip": mutated_host,
                    "port": 9200,
                    "render_mode": "text"
                })
                .to_string();
                assert_eq!(
                    conn.execute(
                        "UPDATE printer_profiles
                         SET printer_name = ?1, connection_json = ?2, updated_at = datetime('now')
                         WHERE id = ?3",
                        params![mutated_host, mutated_connection, profile_id],
                    )
                    .expect("mutate live printer profile"),
                    1
                );
                conn.execute(
                    "INSERT INTO print_jobs (
                         id, entity_type, entity_id, printer_profile_id,
                         status, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, 'pending', datetime('now'), datetime('now'))",
                    params![control_job_id, entity_type, entity_id, profile_id],
                )
                .expect("insert fresh mutated control job");
            }
            let original = raw.calls.lock().unwrap()[0].clone();
            assert_eq!(
                original.target,
                printers::ResolvedPrinterTarget::RawTcp {
                    host: original_host.clone(),
                    port: 9100,
                }
            );

            assert_eq!(
                process_pending_jobs_with_adapters(
                    &db,
                    &data_dir,
                    &manager,
                    &raw,
                    Arc::clone(&spooler),
                    Duration::from_secs(1),
                )
                .expect("dispatch fresh mutated control"),
                1
            );
            let mutated_control = raw.calls.lock().unwrap()[1].clone();
            assert_ne!(
                mutated_control.bytes, original.bytes,
                "{entity_type} live mutation must change a freshly rendered document"
            );
            assert_eq!(
                mutated_control.target,
                printers::ResolvedPrinterTarget::RawTcp {
                    host: mutated_host,
                    port: 9200,
                },
                "fresh control must resolve the mutated profile target"
            );
            assert_ne!(mutated_control.target, original.target);

            let cloned = crate::print_history::clone_reprint_job(&db, &source_job_id, Utc::now())
                .expect("clone frozen financial document");
            assert_eq!(cloned.affected, 1);
            let child_job_id = cloned.new_job_id.expect("Reprint child ID");

            assert_eq!(
                process_pending_jobs_with_adapters(
                    &db,
                    &data_dir,
                    &manager,
                    &raw,
                    spooler,
                    Duration::from_secs(1),
                )
                .expect("dispatch frozen financial Reprint child"),
                1
            );
            let calls = raw.calls.lock().unwrap();
            assert_eq!(calls.len(), 3);
            assert_eq!(
                calls[2].bytes, original.bytes,
                "{entity_type} Reprint must replay the original frozen bytes"
            );
            assert_eq!(
                calls[2].target, original.target,
                "{entity_type} Reprint must replay the original frozen target"
            );
            assert_ne!(calls[2].bytes, mutated_control.bytes);
            assert_ne!(calls[2].target, mutated_control.target);
            drop(calls);

            let conn = db.conn.lock().unwrap();
            let source_status: String = conn
                .query_row(
                    "SELECT status FROM print_jobs WHERE id = ?1",
                    [&source_job_id],
                    |row| row.get(0),
                )
                .expect("read retained financial source");
            let child: (String, String) = conn
                .query_row(
                    "SELECT status, reprint_of_job_id FROM print_jobs WHERE id = ?1",
                    [&child_job_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read financial Reprint child");
            assert_eq!(source_status, "dispatched");
            assert_eq!(child, ("dispatched".into(), source_job_id));
            drop(conn);
            let _ = std::fs::remove_dir_all(data_dir);
        }
    }

    #[test]
    fn managed_worker_leaves_paused_default_resolution_effect_free_before_claim() {
        let db = test_db();
        let job_id = Uuid::new_v4().to_string();
        let data_dir =
            std::env::temp_dir().join(format!("managed-paused-default-{}", Uuid::new_v4()));
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "paused-order", "P-1", 5.0);
            insert_managed_network_profile(&conn, "paused-default", "paused.local", 9100, true);
            db::set_setting(
                &conn,
                PRINT_QUEUE_SETTINGS_CATEGORY,
                &print_queue_pause_key(Some("paused-default")),
                "true",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'paused-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            ).unwrap();
        }
        let raw = CapturingManagedRaw::default();
        let manager = DispatchManager::isolated_for_test();
        process_pending_jobs_with_adapters(
            &db,
            &data_dir,
            &manager,
            &raw,
            Arc::new(FakeWindowsSpooler::new(1)),
            Duration::from_secs(1),
        )
        .unwrap();
        let conn = db.conn.lock().unwrap();
        assert_parent_has_no_managed_preparation_effects(&conn, &job_id);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM print_job_attempts", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(raw.calls.lock().unwrap().is_empty());
        drop(conn);
        assert!(!data_dir.join(RECEIPTS_DIR).exists());
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn same_target_second_job_stays_pending_while_first_holds_lane() {
        let db = test_db();
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "same-order-1", "S-1", 1.0);
            insert_receipt_order(&conn, "same-order-2", "S-2", 2.0);
            insert_managed_network_profile(&conn, "same-profile", "same.local", 9100, true);
            for (job, order) in [(&first, "same-order-1"), (&second, "same-order-2")] {
                conn.execute(
                    "INSERT INTO print_jobs (id, entity_type, entity_id, printer_profile_id, status, created_at, updated_at)
                     VALUES (?1, 'order_receipt', ?2, 'same-profile', 'pending', datetime('now'), datetime('now'))",
                    params![job, order],
                ).unwrap();
            }
        }
        let raw = CapturingManagedRaw::default();
        process_pending_jobs_with_adapters(
            &db,
            &std::env::temp_dir(),
            &DispatchManager::isolated_for_test(),
            &raw,
            Arc::new(FakeWindowsSpooler::new(1)),
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(raw.calls.lock().unwrap().len(), 1);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE status = 'pending'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE status = 'dispatched'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    struct BlockingTargetsRaw {
        blocked_host: String,
        state: (Mutex<(bool, bool)>, std::sync::Condvar),
        other_started: std::sync::mpsc::Sender<()>,
    }

    impl BlockingTargetsRaw {
        fn wait_until_blocked(&self) -> bool {
            let state = self.state.0.lock().unwrap();
            let (state, timeout) = self
                .state
                .1
                .wait_timeout_while(state, Duration::from_secs(30), |(entered, _)| !*entered)
                .unwrap();
            !timeout.timed_out() && state.0
        }

        fn release(&self) {
            let mut state = self.state.0.lock().unwrap();
            state.1 = true;
            self.state.1.notify_all();
        }
    }

    impl ManagedRawTransport for BlockingTargetsRaw {
        fn send(
            &self,
            _db: &DbState,
            target: &printers::ResolvedPrinterTarget,
            bytes: &[u8],
            _document_name: &str,
            _cancel: &AtomicBool,
        ) -> Result<printers::RawPrintResult, printers::RawTransportFailure> {
            let host = match target {
                printers::ResolvedPrinterTarget::RawTcp { host, .. } => host,
                _ => panic!("expected raw target"),
            };
            if host == &self.blocked_host {
                let mut state = self.state.0.lock().unwrap();
                state.0 = true;
                self.state.1.notify_all();
                while !state.1 {
                    state = self.state.1.wait(state).unwrap();
                }
            } else {
                self.other_started.send(()).unwrap();
            }
            Ok(printers::RawPrintResult {
                bytes_requested: bytes.len(),
                bytes_written: bytes.len(),
                doc_name: "managed".into(),
                spool_job_id: None,
            })
        }
    }

    #[test]
    fn blocked_target_a_does_not_prevent_target_b_from_dispatching() {
        let db = Arc::new(test_db());
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "blocked-a-order", "A-1", 1.0);
            insert_receipt_order(&conn, "free-b-order", "B-1", 2.0);
            insert_managed_network_profile(&conn, "profile-a", "blocked.local", 9100, false);
            insert_managed_network_profile(&conn, "profile-b", "free.local", 9100, false);
            for (profile, order) in [
                ("profile-a", "blocked-a-order"),
                ("profile-b", "free-b-order"),
            ] {
                conn.execute(
                    "INSERT INTO print_jobs (id, entity_type, entity_id, printer_profile_id, status, created_at, updated_at)
                     VALUES (?1, 'order_receipt', ?2, ?3, 'pending', datetime('now'), datetime('now'))",
                    params![Uuid::new_v4().to_string(), order, profile],
                ).unwrap();
            }
        }
        let (other_tx, other_rx) = std::sync::mpsc::channel();
        let raw = Arc::new(BlockingTargetsRaw {
            blocked_host: "blocked.local".into(),
            state: (Mutex::new((false, false)), std::sync::Condvar::new()),
            other_started: other_tx,
        });
        let worker_db = Arc::clone(&db);
        let worker_raw = Arc::clone(&raw);
        let data_dir = std::env::temp_dir().join(format!("managed-concurrency-{}", Uuid::new_v4()));
        let worker_dir = data_dir.clone();
        let worker = std::thread::spawn(move || {
            process_pending_jobs_with_adapters(
                &worker_db,
                &worker_dir,
                &DispatchManager::isolated_for_test(),
                worker_raw.as_ref(),
                Arc::new(FakeWindowsSpooler::new(1)),
                Duration::from_secs(1),
            )
        });
        if !raw.wait_until_blocked() {
            raw.release();
            let worker_result = worker.join().unwrap();
            let conn = db.conn.lock().unwrap();
            let errors: Vec<(String, String, Option<String>)> = conn
                .prepare("SELECT entity_id, status, last_error FROM print_jobs ORDER BY entity_id")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            panic!(
                "blocked target never entered transport; worker={worker_result:?}, jobs={errors:?}"
            );
        }
        let other_result = other_rx.recv_timeout(Duration::from_secs(5));
        raw.release();
        other_result.expect("target B must start while A is blocked");
        assert_eq!(worker.join().unwrap().unwrap(), 2);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE status = 'dispatched'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn windows_job_id_is_durable_before_fake_writer_is_released() {
        let (db, db_dir) = managed_file_db();
        let job_id = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "windows-order", "W-1", 4.0);
            insert_managed_windows_profile(&conn, "windows-profile", "Fake Queue");
            conn.execute(
                "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'windows-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            ).unwrap();
        }
        let fake = Arc::new(FakeWindowsSpooler::new(4242));
        fake.set_block_after_started(true);
        fake.set_block_timeout(Duration::from_secs(30));
        let manager = Arc::new(DispatchManager::isolated_for_test());
        let worker_db = Arc::clone(&db);
        let worker_fake: Arc<dyn WindowsSpooler> = fake.clone();
        let worker_manager = Arc::clone(&manager);
        let data_dir = db_dir.join("output");
        let worker_dir = data_dir.clone();
        let worker = std::thread::spawn(move || {
            process_pending_jobs_with_adapters(
                &worker_db,
                &worker_dir,
                &worker_manager,
                &CapturingManagedRaw::default(),
                worker_fake,
                Duration::from_secs(10),
            )
        });
        assert!(fake.wait_until_submission_blocked(Duration::from_secs(15)));
        {
            let conn = db.conn.lock().unwrap();
            let durable: (String, i64, String) = conn.query_row(
                "SELECT state, spool_job_id, document_name FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).unwrap();
            assert_eq!(durable.0, "windows_queued");
            assert_eq!(durable.1, 4242);
            assert!(durable.2.starts_with(&format!("TheSmallPOS/{job_id}/")));
            assert!(
                fake.submissions().is_empty(),
                "payload must wait behind durable callback"
            );
        }
        fake.release_submission_block();
        assert_eq!(worker.join().unwrap().unwrap(), 1);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "dispatched"
        );
        assert_eq!(
            conn.query_row(
                "SELECT state FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "windows_queued"
        );
        drop(conn);
        assert!(matches!(
            manager.claim(PrinterTargetKey::WindowsQueue("Fake Queue".into())),
            Err(crate::print_dispatch::DispatchError::LaneBusy)
        ));
        drop(db);
        let _ = std::fs::remove_dir_all(db_dir);
    }

    #[test]
    fn windows_callback_db_failure_after_job_id_is_unknown_before_payload_write() {
        let (db, db_dir) = managed_file_db();
        let job_id = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "windows-cas-order", "W-2", 4.0);
            insert_managed_windows_profile(&conn, "windows-cas-profile", "CAS Queue");
            conn.execute(
                "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'windows-cas-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            ).unwrap();
            conn.execute_batch(
                "CREATE TRIGGER reject_spool_identity
                 BEFORE UPDATE OF spool_job_id ON print_job_attempts
                 WHEN NEW.spool_job_id IS NOT NULL
                 BEGIN SELECT RAISE(ABORT, 'injected callback failure'); END;",
            )
            .unwrap();
        }
        let fake = Arc::new(FakeWindowsSpooler::new(81));
        let spooler: Arc<dyn WindowsSpooler> = fake.clone();
        let manager = DispatchManager::isolated_for_test();
        process_pending_jobs_with_adapters(
            &db,
            &db_dir.join("output"),
            &manager,
            &CapturingManagedRaw::default(),
            spooler,
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(fake.submissions().is_empty());
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT state FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "unknown"
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "failed"
        );
        drop(conn);
        assert!(matches!(
            manager.claim(PrinterTargetKey::WindowsQueue("CAS Queue".into())),
            Err(crate::print_dispatch::DispatchError::CircuitOpen)
        ));
        drop(db);
        let _ = std::fs::remove_dir_all(db_dir);
    }

    struct LateSuccessWindowsSpooler {
        state: (Mutex<(bool, bool, bool)>, std::sync::Condvar),
        completed_submissions: AtomicUsize,
    }

    impl LateSuccessWindowsSpooler {
        fn wait_until_started(&self, timeout: Duration) -> bool {
            let state = self.state.0.lock().unwrap();
            let (state, _) = self
                .state
                .1
                .wait_timeout_while(state, timeout, |state| !state.0)
                .unwrap();
            state.0
        }

        fn release(&self) {
            let mut state = self.state.0.lock().unwrap();
            state.1 = true;
            self.state.1.notify_all();
        }

        fn wait_finished(&self) {
            let state = self.state.0.lock().unwrap();
            let (state, timeout) = self
                .state
                .1
                .wait_timeout_while(state, Duration::from_secs(5), |state| !state.2)
                .unwrap();
            assert!(!timeout.timed_out() && state.2);
        }
    }

    impl WindowsSpooler for LateSuccessWindowsSpooler {
        fn submit_raw(
            &self,
            request: WindowsRawRequest,
            _cancel: &AtomicBool,
            on_started: &mut dyn FnMut(
                &crate::windows_spooler::SpoolStarted,
            ) -> Result<(), SpoolerError>,
        ) -> Result<crate::windows_spooler::SpoolSubmission, SpoolerError> {
            let started = crate::windows_spooler::SpoolStarted {
                job_id: 606,
                printer_name: request.printer_name,
                document_name: request.document_name,
                submitted_at: Utc::now(),
            };
            on_started(&started)?;
            let mut state = self.state.0.lock().unwrap();
            state.0 = true;
            self.state.1.notify_all();
            while !state.1 {
                state = self.state.1.wait(state).unwrap();
            }
            self.completed_submissions.fetch_add(1, Ordering::SeqCst);
            state.2 = true;
            self.state.1.notify_all();
            Ok(crate::windows_spooler::SpoolSubmission { started })
        }

        fn get_job(
            &self,
            _printer_name: &str,
            _job_id: crate::windows_spooler::WindowsJobId,
        ) -> Result<Option<crate::windows_spooler::SpoolJobSnapshot>, SpoolerError> {
            Ok(None)
        }

        fn enum_jobs(
            &self,
            _printer_name: &str,
        ) -> Result<Vec<crate::windows_spooler::SpoolJobSnapshot>, SpoolerError> {
            Ok(Vec::new())
        }

        fn control_job(
            &self,
            _printer_name: &str,
            _job_id: crate::windows_spooler::WindowsJobId,
            _control: crate::windows_spooler::SpoolJobControl,
        ) -> Result<(), SpoolerError> {
            Ok(())
        }
    }

    #[test]
    fn timeout_after_windows_start_is_unknown_and_late_success_changes_nothing() {
        let (db, db_dir) = managed_file_db();
        let job_id = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "late-windows-order", "W-3", 4.0);
            insert_managed_windows_profile(&conn, "late-windows-profile", "Late Queue");
            conn.execute(
                "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'late-windows-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            ).unwrap();
        }
        let late = Arc::new(LateSuccessWindowsSpooler {
            state: (Mutex::new((false, false, false)), std::sync::Condvar::new()),
            completed_submissions: AtomicUsize::new(0),
        });
        let manager = Arc::new(DispatchManager::isolated_for_test());
        let worker_db = Arc::clone(&db);
        let worker_manager = Arc::clone(&manager);
        let worker_spooler: Arc<dyn WindowsSpooler> = late.clone();
        let output_dir = db_dir.join("output");
        let worker = std::thread::spawn(move || {
            process_pending_jobs_with_adapters(
                &worker_db,
                &output_dir,
                &worker_manager,
                &CapturingManagedRaw::default(),
                worker_spooler,
                Duration::from_secs(1),
            )
        });
        // 30s, not 5: test-side patience only — on a loaded CI runner the
        // detached native thread can take that long to be scheduled (fourth
        // member of the print-concurrency flake family, run 33092046600).
        if !late.wait_until_started(Duration::from_secs(30)) {
            late.release();
            let worker_result = worker.join().unwrap();
            panic!("Windows start callback did not finish before timeout: {worker_result:?}");
        }
        assert_eq!(worker.join().unwrap().unwrap(), 1);
        {
            let conn = db.conn.lock().unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT state FROM print_job_attempts WHERE print_job_id = ?1",
                    [&job_id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
                "unknown"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM print_jobs WHERE id = ?1",
                    [&job_id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
                "failed"
            );
        }
        assert!(matches!(
            manager.claim(PrinterTargetKey::WindowsQueue("Late Queue".into())),
            Err(crate::print_dispatch::DispatchError::CircuitOpen)
        ));
        late.release();
        late.wait_finished();
        assert_eq!(late.completed_submissions.load(Ordering::SeqCst), 1);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT state FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "unknown"
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "failed"
        );
        drop(conn);
        drop(db);
        let _ = std::fs::remove_dir_all(db_dir);
    }

    struct ClassifiedFailureRaw;

    impl ManagedRawTransport for ClassifiedFailureRaw {
        fn send(
            &self,
            _db: &DbState,
            target: &printers::ResolvedPrinterTarget,
            bytes: &[u8],
            _document_name: &str,
            _cancel: &AtomicBool,
        ) -> Result<printers::RawPrintResult, printers::RawTransportFailure> {
            let host = match target {
                printers::ResolvedPrinterTarget::RawTcp { host, .. } => host.as_str(),
                _ => panic!("expected raw target"),
            };
            if host == "prewrite.local" {
                Err(printers::RawTransportFailure {
                    kind: printers::RawTransportFailureKind::DefinitelyNotSent,
                    bytes_requested: bytes.len(),
                    bytes_written: 0,
                    message: "connect failed before write".into(),
                })
            } else {
                Err(printers::RawTransportFailure {
                    kind: printers::RawTransportFailureKind::AmbiguousAfterWrite,
                    bytes_requested: bytes.len(),
                    bytes_written: bytes.len().min(2),
                    message: "write failed after transmission started".into(),
                })
            }
        }
    }

    #[test]
    fn managed_raw_prewrite_is_retryable_but_partial_failure_is_unknown() {
        let db = test_db();
        let prewrite_job = Uuid::new_v4().to_string();
        let ambiguous_job = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "prewrite-order", "R-1", 1.0);
            insert_receipt_order(&conn, "ambiguous-order", "R-2", 2.0);
            insert_managed_network_profile(
                &conn,
                "prewrite-profile",
                "prewrite.local",
                9100,
                false,
            );
            insert_managed_network_profile(
                &conn,
                "ambiguous-profile",
                "ambiguous.local",
                9100,
                false,
            );
            for (job, order, profile) in [
                (&prewrite_job, "prewrite-order", "prewrite-profile"),
                (&ambiguous_job, "ambiguous-order", "ambiguous-profile"),
            ] {
                conn.execute(
                    "INSERT INTO print_jobs (id, entity_type, entity_id, printer_profile_id, status, created_at, updated_at)
                     VALUES (?1, 'order_receipt', ?2, ?3, 'pending', datetime('now'), datetime('now'))",
                    params![job, order, profile],
                ).unwrap();
            }
        }
        let manager = DispatchManager::isolated_for_test();
        process_pending_jobs_with_adapters(
            &db,
            &std::env::temp_dir(),
            &manager,
            &ClassifiedFailureRaw,
            Arc::new(FakeWindowsSpooler::new(1)),
            Duration::from_secs(1),
        )
        .unwrap();
        let conn = db.conn.lock().unwrap();
        let prewrite: (String, String, i64) = conn.query_row(
            "SELECT j.status, a.state, a.bytes_written FROM print_jobs j JOIN print_job_attempts a ON a.print_job_id = j.id WHERE j.id = ?1",
            [&prewrite_job],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(prewrite, ("pending".into(), "transport_error".into(), 0));
        let ambiguous: (String, String, i64) = conn.query_row(
            "SELECT j.status, a.state, a.bytes_written FROM print_jobs j JOIN print_job_attempts a ON a.print_job_id = j.id WHERE j.id = ?1",
            [&ambiguous_job],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(ambiguous.0, "failed");
        assert_eq!(ambiguous.1, "unknown");
        assert!(ambiguous.2 > 0);
        drop(conn);
        assert!(matches!(
            manager.claim(PrinterTargetKey::RawTcp {
                host: "ambiguous.local".into(),
                port: 9100
            }),
            Err(crate::print_dispatch::DispatchError::CircuitOpen)
        ));
        assert!(manager
            .claim(PrinterTargetKey::RawTcp {
                host: "prewrite.local".into(),
                port: 9100
            })
            .is_ok());
    }

    #[test]
    fn managed_invalid_legacy_partial_corrupt_and_mismatched_snapshots_never_reach_transport() {
        let db = test_db();
        let partial_job = Uuid::new_v4().to_string();
        let corrupt_job = Uuid::new_v4().to_string();
        let mismatch_job = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            for job_id in ["legacy-job", &partial_job, &corrupt_job, &mismatch_job] {
                conn.execute(
                    "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
                     VALUES (?1, 'order_receipt', 'missing-entity', 'pending', datetime('now'), datetime('now'))",
                    [job_id],
                ).unwrap();
            }
            conn.execute(
                "UPDATE print_jobs SET document_snapshot_version = 1 WHERE id = ?1",
                [&partial_job],
            )
            .unwrap();
            let encoded = crate::print_snapshot::encode_print_payload(b"frozen").unwrap();
            crate::print_snapshot::persist_snapshot_if_absent(&conn, &corrupt_job, &encoded, "{}")
                .unwrap();
            let mismatched = FrozenRenderEnvelope {
                version: MANAGED_ENVELOPE_VERSION,
                renderer_layout_revision: "test".into(),
                effective_profile_id: "profile".into(),
                effective_profile_name: "Profile".into(),
                driver_type: "windows".into(),
                document_kind: "kitchen_ticket".into(),
                transport: FrozenTargetEnvelope::RawTcp {
                    host: "safe.local".into(),
                    port: 9100,
                },
                paper_width_mm: 80,
                printable_width_dots: 576,
                left_margin_dots: 0,
                encoding: "PC437_USA".into(),
                code_page: None,
                greek_render_mode: None,
                command_profile: "full_style".into(),
                emulation: "auto".into(),
                template: "classic".into(),
                font_type: "a".into(),
                layout_density: "compact".into(),
                header_emphasis: "strong".into(),
                layout_density_scale: 1.0,
                text_scale: 1.25,
                classic_customer_render_mode: "text".into(),
                raster_threshold: 160,
                body_font_weight: 400,
                decimal_comma: false,
                detected_brand: "unknown".into(),
                language: "en".into(),
                organization_name: "Test Organization".into(),
                store_subtitle: None,
                store_address: None,
                store_phone: None,
                vat_number: None,
                tax_office: None,
                footer_text: None,
                show_qr_code: false,
                qr_configured: false,
                copy_label: None,
                currency_symbol: String::new(),
                cut_paper: true,
                logo_enabled: false,
                logo_configured: false,
                logo_included: false,
                logo_scale: 1.0,
                drawer: FrozenDrawerConfig {
                    profile_id: "profile".into(),
                    enabled: false,
                    mode: "none".into(),
                    host: None,
                    port: 9100,
                },
                warning_codes: Vec::new(),
            };
            crate::print_snapshot::persist_snapshot_if_absent(
                &conn,
                &mismatch_job,
                &encoded,
                &serde_json::to_string(&mismatched).unwrap(),
            )
            .unwrap();
        }
        let raw = CapturingManagedRaw::default();
        process_pending_jobs_with_adapters(
            &db,
            &std::env::temp_dir(),
            &DispatchManager::isolated_for_test(),
            &raw,
            Arc::new(FakeWindowsSpooler::new(1)),
            Duration::from_secs(1),
        )
        .unwrap();
        assert!(raw.calls.lock().unwrap().is_empty());
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE status = 'failed'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            4
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM print_job_attempts", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_order_payment(
        conn: &Connection,
        payment_id: &str,
        order_id: &str,
        method: &str,
        amount: f64,
        cash_received: Option<f64>,
        change_given: Option<f64>,
        transaction_ref: Option<&str>,
    ) {
        // W4e Step 0: dual-populate amount + amount_cents (and cash_received_cents
        // / change_given_cents only if the f64 value is Some).
        let amount_cents = Cents::round_half_even(amount).as_i64();
        let cash_received_cents = cash_received.map(|v| Cents::round_half_even(v).as_i64());
        let change_given_cents = change_given.map(|v| Cents::round_half_even(v).as_i64());
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status,
                cash_received, cash_received_cents, change_given, change_given_cents,
                transaction_ref, sync_status, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, 'completed', ?6, ?7, ?8, ?9,
                ?10, 'pending', datetime('now'), datetime('now')
             )",
            params![
                payment_id,
                order_id,
                method,
                amount,
                amount_cents,
                cash_received,
                cash_received_cents,
                change_given,
                change_given_cents,
                transaction_ref
            ],
        )
        .expect("insert test payment");
    }

    fn insert_shift_checkout_fixture(conn: &Connection, shift_id: &str, terminal_id: &str) {
        // W4e Step 0: dual-populate every monetary column (100/125/0/25/15/10/0 → 10000/12500/0/2500/1500/1000/0).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, status,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, total_orders_count,
                total_sales_amount, total_sales_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                total_card_sales, total_card_sales_cents,
                branch_id, terminal_id, calculation_version,
                payment_amount, payment_amount_cents,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'staff-1', 'Alice', 'cashier', 'closed',
                100.0, 10000, 125.0, 12500, 125.0, 12500, 0.0, 0,
                '2026-03-15T08:00:00Z', '2026-03-15T16:00:00Z', 3,
                25.0, 2500, 15.0, 1500, 10.0, 1000,
                'branch-1', ?2, 2,
                0.0, 0, 'pending', '2026-03-15T16:00:00Z', '2026-03-15T16:00:00Z'
             )",
            params![shift_id, terminal_id],
        )
        .expect("insert shift checkout fixture");
    }

    fn insert_active_cashier_fixture(conn: &Connection, shift_id: &str, drawer_id: &str) {
        // W4e Step 0: dual-populate (200.0/0.0 → 20000/0).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                '2026-03-18T08:00:00Z', 200.0, 20000, 'active', 2,
                'pending', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
             )",
            params![shift_id],
        )
        .expect("insert active cashier fixture");
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                driver_cash_given, driver_cash_given_cents,
                opened_at, created_at, updated_at
             ) VALUES (
                ?1, ?2, 'cashier-1', 'branch-1', 'term-1',
                200.0, 20000, 0.0, 0, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
             )",
            params![drawer_id, shift_id],
        )
        .expect("insert active cashier drawer fixture");
    }

    #[test]
    fn test_parse_item_customizations_from_server_object_shape() {
        // The server mirrors platform items with customizations as an object
        // wrapping the modifier list (live efood order 26/08) — the materials
        // must not be dropped.
        let item = serde_json::json!({
            "customizations": {
                "modifiers": [
                    { "name": "Μονός", "price": 0 },
                    { "name": "Πολύ γλυκός", "price": 0 }
                ],
                "external_sku": "1423280112",
                "platform_source": "efood"
            }
        });
        let parsed = parse_item_customizations(&item);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "Μονός");
        assert_eq!(parsed[1].name, "Πολύ γλυκός");
    }

    #[test]
    fn test_parse_item_customizations_from_array() {
        let item = serde_json::json!({
            "customizations": [
                {
                    "ingredient": { "name": "Feta", "price": 0.5 },
                    "quantity": 2
                },
                {
                    "name": "Onion",
                    "isWithout": true
                }
            ]
        });

        let parsed = parse_item_customizations(&item);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "Feta");
        assert_eq!(parsed[0].quantity, 2.0);
        assert_eq!(parsed[0].price, Some(0.5));
        assert!(!parsed[0].is_without);
        assert_eq!(parsed[1].name, "Onion");
        assert!(parsed[1].is_without);
        assert!(parsed[1].price.is_none());
    }

    #[test]
    fn test_parse_item_customizations_from_json_string_map() {
        let item = serde_json::json!({
            "modifiers": "{\"a\":{\"ingredient\":{\"name_en\":\"Olives\",\"pickup_price\":\"0.20\"},\"quantity\":\"2\"},\"b\":{\"label\":\"Tomato\",\"without\":true}}"
        });

        let parsed = parse_item_customizations(&item);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "Olives");
        assert_eq!(parsed[0].quantity, 2.0);
        assert_eq!(parsed[0].price, Some(0.2));
        assert_eq!(parsed[1].name, "Tomato");
        assert!(parsed[1].is_without);
    }

    #[test]
    fn test_parse_item_customizations_handles_malformed_json() {
        let item = serde_json::json!({
            "customizations": "{bad json",
            "ingredients": "[]"
        });

        let parsed = parse_item_customizations(&item);
        assert!(parsed.is_empty());
    }

    #[test]
    fn test_parse_data_url_image_png() {
        let mut encoded = Vec::new();
        let logo =
            image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(2, 2, image::Luma([0])));
        logo.write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .expect("encode png");
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded)
        );
        let bytes = parse_data_url_image(&data_url).expect("data url should decode");
        assert!(!bytes.is_empty());
    }

    #[test]
    fn test_build_logo_prefix_for_layout_from_data_url() {
        let mut encoded = Vec::new();
        let logo =
            image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(2, 2, image::Luma([0])));
        logo.write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .expect("encode png");
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded)
        );
        let layout = LayoutConfig {
            show_logo: true,
            logo_url: Some(data_url),
            ..LayoutConfig::default()
        };
        let prefix = build_logo_prefix_for_layout(&layout)
            .expect("logo prefix result")
            .expect("logo prefix present");
        // ESC * 33 (24-dot double-density column-format bit image)
        assert!(prefix.windows(3).any(|window| window == [0x1B, b'*', 33]));
    }

    #[test]
    fn test_build_logo_prefix_for_star_layout_keeps_logo_compact() {
        let mut encoded = Vec::new();
        let logo = image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(
            400,
            400,
            image::Luma([0]),
        ));
        logo.write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .expect("encode png");
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded)
        );
        let layout = LayoutConfig {
            show_logo: true,
            logo_url: Some(data_url),
            paper_width: crate::escpos::PaperWidth::Mm80,
            detected_brand: crate::printers::PrinterBrand::Star,
            ..LayoutConfig::default()
        };
        let prefix = build_logo_prefix_for_layout(&layout)
            .expect("logo prefix result")
            .expect("logo prefix present");

        // Star logos use Star raster mode (ESC * r A).
        // GS v 0 is NOT supported by Star printers.
        assert!(
            prefix
                .windows(4)
                .any(|window| window == [0x1B, b'*', b'r', b'A']),
            "expected Star raster header (ESC * r A) for Star printer logo"
        );
        assert!(
            !prefix
                .windows(4)
                .any(|window| window == [0x1D, b'v', b'0', 0x00]),
            "GS v 0 raster should NOT be used for Star printer logo"
        );
        assert!(
            prefix.len() < 60_000,
            "expected compact Star logo raster, got {} bytes",
            prefix.len()
        );
    }

    #[test]
    fn test_load_receipt_like_logo_image_from_data_url() {
        let mut encoded = Vec::new();
        let logo = image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(
            240,
            180,
            image::Luma([0]),
        ));
        logo.write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .expect("encode png");
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded)
        );
        let layout = LayoutConfig {
            show_logo: true,
            logo_url: Some(data_url),
            paper_width: crate::escpos::PaperWidth::Mm80,
            printable_width_dots: 576,
            ..LayoutConfig::default()
        };

        let image = load_receipt_like_logo_image(&layout)
            .expect("load logo image")
            .expect("logo image should be present");

        assert!(image.width() <= 260);
        assert!(image.height() <= 160);
    }

    #[test]
    fn test_build_order_receipt_doc_includes_delivery_fields() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (10.0 → 1000).
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type,
                    delivery_address, delivery_city, delivery_postal_code, delivery_floor,
                    name_on_ringer, driver_name, delivery_notes, sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-delivery', 'ORD-DEL-1', '[]', 10.0, 1000, 10.0, 1000, 'delivered', 'delivery',
                    'Main St 42', 'Athens', '10558', '2', 'Papadopoulos', 'Nikos Driver', 'Leave at the gate',
                    'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-delivery").unwrap();
        assert_eq!(doc.status, "delivered");
        assert_eq!(doc.delivery_address.as_deref(), Some("Main St 42"));
        assert_eq!(doc.delivery_city.as_deref(), Some("Athens"));
        assert_eq!(doc.delivery_postal_code.as_deref(), Some("10558"));
        assert_eq!(doc.delivery_floor.as_deref(), Some("2"));
        assert_eq!(doc.name_on_ringer.as_deref(), Some("Papadopoulos"));
        assert_eq!(doc.driver_name.as_deref(), Some("Nikos Driver"));
        assert!(doc
            .order_notes
            .iter()
            .any(|note| note == "Leave at the gate"));
        assert_eq!(doc.driver_id, None);
        assert_eq!(doc.delivery_slip_mode, DeliverySlipMode::DeliveryOrder);
    }

    #[test]
    fn test_build_order_receipt_doc_resolves_driver_name_from_shift() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, role_type, check_in_time, status, sync_status, created_at, updated_at
                 ) VALUES (
                    'shift-driver', 'driver-1', 'Shift Driver', 'driver', datetime('now'), 'active', 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
            // W4e Step 0: dual-populate (8.0 → 800).
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type,
                    driver_id, sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-delivery-fallback', 'ORD-DEL-2', '[]', 8.0, 800, 8.0, 800, 'completed', 'delivery',
                    'driver-1', 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-delivery-fallback").unwrap();
        assert_eq!(doc.driver_name.as_deref(), Some("Shift Driver"));
        assert_eq!(doc.driver_id.as_deref(), Some("driver-1"));
        assert_eq!(doc.delivery_slip_mode, DeliverySlipMode::DeliveryOrder);
    }

    #[test]
    fn test_build_document_for_job_delivery_slip_defaults_to_delivery_order_mode() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (10.0 → 1000).
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type,
                    customer_name, customer_phone, delivery_address, delivery_city,
                    delivery_postal_code, delivery_floor, name_on_ringer, driver_id,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-slip-default', 'ORD-DSL-1', '[]', 10.0, 1000, 10.0, 1000, 'pending', 'delivery',
                    'Customer One', '2100000000', 'Main St 42', 'Athens', '10558', '2', 'Papadopoulos',
                    'drv-22', 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let doc = build_document_for_job(&db, "delivery_slip", "ord-slip-default", None).unwrap();
        match doc {
            ReceiptDocument::DeliverySlip(doc) => {
                assert_eq!(doc.delivery_slip_mode, DeliverySlipMode::DeliveryOrder);
                assert_eq!(doc.driver_id.as_deref(), Some("drv-22"));
            }
            _ => panic!("expected delivery slip document"),
        }
    }

    #[test]
    fn test_build_document_for_job_delivery_slip_applies_assign_payload_and_driver_fallbacks() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (12.0 → 1200).
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type,
                    customer_name, customer_phone, delivery_address, delivery_city,
                    delivery_postal_code, delivery_floor, name_on_ringer,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-slip-assign', 'ORD-DSL-2', '[]', 12.0, 1200, 12.0, 1200, 'pending', 'delivery',
                    'Customer Two', '2100000001', 'Second St 10', 'Athens', '10559', '1', 'Kostas',
                    'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }
        let payload = serde_json::json!({
            "slip_mode": "assign_driver",
            "driverId": "drv-99",
            "driverName": "Assigned Driver"
        });
        let raw_payload = payload.to_string();
        let doc = build_document_for_job(
            &db,
            "delivery_slip",
            "ord-slip-assign",
            Some(raw_payload.as_str()),
        )
        .unwrap();
        match doc {
            ReceiptDocument::DeliverySlip(doc) => {
                assert_eq!(doc.delivery_slip_mode, DeliverySlipMode::AssignDriver);
                assert_eq!(doc.driver_id.as_deref(), Some("drv-99"));
                assert_eq!(doc.driver_name.as_deref(), Some("Assigned Driver"));
            }
            _ => panic!("expected delivery slip document"),
        }
    }

    #[test]
    fn test_build_document_for_job_shift_checkout_uses_display_terminal_name() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_shift_checkout_fixture(&conn, "shift-checkout-1", "terminal-9bf9dfce");
            db::set_setting(&conn, "terminal", "name", "Front Counter")
                .expect("set terminal display name");
        }

        let doc = build_document_for_job(&db, "shift_checkout", "shift-checkout-1", None).unwrap();
        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.terminal_name, "Front Counter");
                assert_eq!(doc.role_type, "cashier");
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_cashier_shift_checkout_prints_each_expense_from_that_shift() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_shift_checkout_fixture(&conn, "shift-checkout-expenses", "terminal-1");
            conn.execute(
                "INSERT INTO shift_expenses (
                    id, staff_shift_id, staff_id, branch_id, expense_type,
                    amount, amount_cents, description, status, sync_status,
                    created_at, updated_at
                 ) VALUES
                    ('expense-fuel', 'shift-checkout-expenses', 'staff-1', 'branch-1', 'other',
                     7.20, 720, 'Fuel for delivery scooter', 'pending', 'pending',
                     '2026-03-15T12:00:00Z', '2026-03-15T12:00:00Z'),
                    ('expense-supplies', 'shift-checkout-expenses', 'staff-1', 'branch-1', 'supplies',
                     3.80, 380, 'Cleaning supplies', 'approved', 'pending',
                     '2026-03-15T13:00:00Z', '2026-03-15T13:00:00Z')",
                [],
            )
            .expect("insert cashier shift expenses");
        }

        let document =
            build_document_for_job(&db, "shift_checkout", "shift-checkout-expenses", None)
                .expect("build cashier checkout with expenses");
        let html = receipt_renderer::render_html(&document, &LayoutConfig::default());

        assert!(html.contains("Fuel for delivery scooter"));
        assert!(html.contains("Cleaning supplies"));
        assert!(html.contains("7.20"));
        assert!(html.contains("3.80"));
    }

    #[test]
    fn test_build_document_for_job_shift_checkout_payload_overrides_snapshot_values() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_shift_checkout_fixture(&conn, "shift-checkout-snapshot", "terminal-1");
        }

        let payload = serde_json::json!({
            "snapshotCheckOutTime": "2026-03-24T10:15:00Z",
            "expectedAmount": 161.0,
            "closingAmount": 165.5,
            "varianceAmount": 4.5
        })
        .to_string();

        let doc = build_document_for_job(
            &db,
            "shift_checkout",
            "shift-checkout-snapshot",
            Some(payload.as_str()),
        )
        .expect("build shift checkout doc with snapshot payload");

        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.check_out, "2026-03-24T10:15:00Z");
                assert_eq!(doc.expected_amount, Some(161.0));
                assert_eq!(doc.closing_amount, Some(165.5));
                assert_eq!(doc.variance_amount, Some(4.5));
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_non_financial_shift_checkout_prefers_snapshot_timestamp() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_shift_checkout_fixture(&conn, "shift-checkout-kitchen", "terminal-1");
        }

        let payload = serde_json::json!({
            "roleType": "kitchen",
            "snapshotCheckOutTime": "2026-03-24T11:45:00Z"
        })
        .to_string();

        let doc = build_document_for_job(
            &db,
            "shift_checkout",
            "shift-checkout-kitchen",
            Some(payload.as_str()),
        )
        .expect("build non-financial shift checkout doc with snapshot payload");

        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.role_type, "kitchen");
                assert_eq!(doc.check_out, "2026-03-24T11:45:00Z");
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_cashier_shift_checkout_includes_transferred_staff_returns() {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();

        let cashier_one = crate::shifts::open_shift(
            &db,
            &serde_json::json!({
                "staffId": "cashier-1",
                "staffName": "Cashier One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "cashier",
                "openingCash": 500.0,
            }),
        )
        .expect("open cashier one");
        let cashier_one_shift_id = cashier_one["shiftId"]
            .as_str()
            .expect("cashier one shift id")
            .to_string();

        crate::shifts::open_shift(
            &db,
            &serde_json::json!({
                "staffId": "driver-1",
                "staffName": "Driver One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "driver",
                "openingCash": 60.0,
            }),
        )
        .expect("open driver");

        crate::shifts::close_shift(
            &db,
            &serde_json::json!({
                "shiftId": cashier_one_shift_id,
                "closingCash": 440.0,
            }),
        )
        .expect("close cashier one");

        let cashier_two = crate::shifts::open_shift(
            &db,
            &serde_json::json!({
                "staffId": "cashier-2",
                "staffName": "Cashier Two",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "cashier",
                "openingCash": 300.0,
            }),
        )
        .expect("open cashier two");
        let cashier_two_shift_id = cashier_two["shiftId"]
            .as_str()
            .expect("cashier two shift id")
            .to_string();

        let doc =
            build_document_for_job(&db, "shift_checkout", cashier_two_shift_id.as_str(), None)
                .expect("build shift checkout doc");

        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.transferred_staff_count, 1);
                assert_eq!(doc.transferred_staff_returns, 60.0);
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_cashier_shift_checkout_includes_staff_payout_breakdown() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_shift_checkout_fixture(&conn, "shift-checkout-payouts", "terminal-1");
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS staff_payments (
                    id TEXT PRIMARY KEY,
                    cashier_shift_id TEXT NOT NULL,
                    paid_to_staff_id TEXT NOT NULL,
                    amount REAL NOT NULL,
                    payment_type TEXT NOT NULL DEFAULT 'wage',
                    notes TEXT,
                    created_at TEXT NOT NULL
                );",
            )
            .expect("create staff_payments table");
            // W4e Step 0: dual-populate every monetary column.
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents,
                    closing_amount, closing_amount_cents,
                    expected_amount, expected_amount_cents,
                    variance_amount, variance_amount_cents,
                    total_cash_sales, total_cash_sales_cents,
                    total_card_sales, total_card_sales_cents,
                    total_refunds, total_refunds_cents,
                    total_expenses, total_expenses_cents,
                    cash_drops, cash_drops_cents,
                    driver_cash_given, driver_cash_given_cents,
                    driver_cash_returned, driver_cash_returned_cents,
                    total_staff_payments, total_staff_payments_cents,
                    opened_at, closed_at, reconciled, created_at, updated_at
                 ) VALUES (
                    ?1, ?2, 'staff-1', 'branch-1', 'terminal-1',
                    100.0, 10000, 125.0, 12500, 81.0, 8100, 44.0, 4400,
                    15.0, 1500, 10.0, 1000, 1.0, 100, 4.0, 400,
                    5.0, 500, 20.0, 2000, 0.0, 0, 34.0, 3400,
                    '2026-03-15T08:00:00Z', '2026-03-15T16:00:00Z', 1, '2026-03-15T08:00:00Z', '2026-03-15T16:00:00Z'
                 )",
                params!["drawer-shift-checkout-payouts", "shift-checkout-payouts"],
            )
            .expect("insert cashier drawer session");
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, role_type, status,
                    check_in_time, check_out_time, branch_id, terminal_id,
                    calculation_version, sync_status, created_at, updated_at
                 ) VALUES (
                    'driver-shift-1', 'driver-1', 'Driver One', 'driver', 'closed',
                    '2026-03-15T10:00:00Z', '2026-03-15T15:00:00Z', 'branch-1', 'terminal-1',
                    2, 'pending', '2026-03-15T10:00:00Z', '2026-03-15T15:00:00Z'
                 )",
                [],
            )
            .expect("insert driver shift");
            conn.execute(
                "INSERT INTO staff_payments (
                    id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at
                 ) VALUES (
                    'staff-payment-1', 'shift-checkout-payouts', 'driver-1', 34.0, 'wage', 'Driver payout', '2026-03-15T15:30:00Z'
                 )",
                [],
            )
            .expect("insert staff payout");
        }

        let doc = build_document_for_job(&db, "shift_checkout", "shift-checkout-payouts", None)
            .expect("build cashier shift checkout doc");

        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.cash_sales, 15.0);
                assert_eq!(doc.card_sales, 10.0);
                assert_eq!(doc.cash_drops, 5.0);
                assert_eq!(doc.driver_cash_given, 20.0);
                assert_eq!(doc.driver_cash_returned, 0.0);
                assert_eq!(doc.staff_payouts_total, 34.0);
                assert_eq!(doc.staff_payout_lines.len(), 1);
                assert_eq!(doc.staff_payout_lines[0].staff_name, "Driver One");
                assert_eq!(doc.staff_payout_lines[0].role_type, "driver");
                assert_eq!(doc.staff_payout_lines[0].amount, 34.0);
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_active_cashier_shift_checkout_prefers_live_instore_totals() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_active_cashier_fixture(&conn, "cashier-shift-live-print", "drawer-live-print");

            // W4e Step 0: dual-populate (30.0/20.0 → 3000/2000).
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type,
                    payment_status, staff_shift_id, terminal_id, branch_id,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'order-live-cash', '#C1', '[]', 30.0, 3000, 30.0, 3000, 'completed', 'pickup',
                    'paid', 'cashier-shift-live-print', 'term-1', 'branch-1',
                    'pending', '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .expect("insert active cashier cash order");
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type,
                    payment_status, staff_shift_id, terminal_id, branch_id,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'order-live-card', '#C2', '[]', 20.0, 2000, 20.0, 2000, 'completed', 'takeaway',
                    'paid', 'cashier-shift-live-print', 'term-1', 'branch-1',
                    'pending', '2026-03-18T09:15:00Z', '2026-03-18T09:15:00Z'
                 )",
                [],
            )
            .expect("insert active cashier card order");
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status, staff_shift_id,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'payment-live-cash', 'order-live-cash', 'cash', 30.0, 3000, 'completed',
                    'cashier-shift-live-print', 'pending', '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .expect("insert active cashier cash payment");
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status, staff_shift_id,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'payment-live-card', 'order-live-card', 'card', 20.0, 2000, 'completed',
                    'cashier-shift-live-print', 'pending', '2026-03-18T09:15:00Z', '2026-03-18T09:15:00Z'
                 )",
                [],
            )
            .expect("insert active cashier card payment");
        }

        let doc = build_document_for_job(&db, "shift_checkout", "cashier-shift-live-print", None)
            .expect("build active cashier shift checkout doc");

        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.role_type, "cashier");
                assert_eq!(doc.orders_count, 2);
                assert_eq!(doc.sales_amount, 50.0);
                assert_eq!(doc.cash_sales, 30.0);
                assert_eq!(doc.card_sales, 20.0);
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_driver_shift_checkout_keeps_amount_to_return_without_delivery_rows(
    ) {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_active_cashier_fixture(&conn, "cashier-shift-1", "drawer-shift-1");
            db::set_setting(&conn, "terminal", "name", "Front Counter")
                .expect("set terminal display name");
        }

        let open_result = crate::shifts::open_shift(
            &db,
            &serde_json::json!({
                "staffId": "driver-1",
                "staffName": "Driver One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "driver",
                "openingCash": 25.0,
            }),
        )
        .expect("open driver shift");
        let driver_shift_id = open_result["shiftId"]
            .as_str()
            .expect("driver shift id")
            .to_string();

        crate::shifts::close_shift(
            &db,
            &serde_json::json!({
                "shiftId": driver_shift_id.as_str(),
                "closingCash": 20.0,
            }),
        )
        .expect("close driver shift");

        let doc = build_document_for_job(&db, "shift_checkout", &driver_shift_id, None).unwrap();
        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.role_type, "driver");
                assert_eq!(doc.terminal_name, "Front Counter");
                assert!(doc.driver_deliveries.is_empty());
                assert_eq!(doc.opening_amount, 25.0);
                assert_eq!(doc.total_cash_collected, 0.0);
                assert_eq!(doc.expected_amount, Some(25.0));
                assert_eq!(doc.total_sells, 0.0);
                assert_eq!(doc.cancelled_or_refunded_total, 0.0);
                assert_eq!(doc.amount_to_return, 25.0);
                assert_eq!(doc.closing_amount, Some(20.0));
                assert_eq!(doc.variance_amount, Some(-5.0));
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_driver_shift_checkout_payload_overrides_manual_snapshot_values()
    {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_active_cashier_fixture(
                &conn,
                "cashier-shift-print-override",
                "drawer-shift-print-override",
            );
        }

        let open_result = crate::shifts::open_shift(
            &db,
            &serde_json::json!({
                "staffId": "driver-print-1",
                "staffName": "Driver Print",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "driver",
                "openingCash": 25.0,
            }),
        )
        .expect("open driver shift");
        let driver_shift_id = open_result["shiftId"]
            .as_str()
            .expect("driver shift id")
            .to_string();

        crate::shifts::close_shift(
            &db,
            &serde_json::json!({
                "shiftId": driver_shift_id.as_str(),
                "closingCash": 20.0,
            }),
        )
        .expect("close driver shift");

        let payload = serde_json::json!({
            "snapshotCheckOutTime": "2026-03-24T12:15:00Z",
            "expectedAmount": 60.0,
            "closingAmount": 62.0,
            "varianceAmount": 2.0
        })
        .to_string();

        let doc = build_document_for_job(
            &db,
            "shift_checkout",
            &driver_shift_id,
            Some(payload.as_str()),
        )
        .expect("build driver shift checkout doc with snapshot payload");

        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.role_type, "driver");
                assert_eq!(doc.check_out, "2026-03-24T12:15:00Z");
                assert_eq!(doc.expected_amount, Some(60.0));
                assert_eq!(doc.closing_amount, Some(62.0));
                assert_eq!(doc.variance_amount, Some(2.0));
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_driver_shift_checkout_uses_driver_totals_instead_of_shift_expected(
    ) {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_active_cashier_fixture(&conn, "cashier-shift-1", "drawer-shift-1");
            db::set_setting(&conn, "terminal", "name", "Front Counter")
                .expect("set terminal display name");
        }

        let open_result = crate::shifts::open_shift(
            &db,
            &serde_json::json!({
                "staffId": "driver-1",
                "staffName": "Driver One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "driver",
                "openingCash": 20.0,
            }),
        )
        .expect("open driver shift");
        let driver_shift_id = open_result["shiftId"]
            .as_str()
            .expect("driver shift id")
            .to_string();
        let now = chrono::Utc::now().to_rfc3339();

        {
            let conn = db.conn.lock().unwrap();

            // W4e Step 0: dual-populate shift_expenses.amount + amount_cents (5.0 → 500).
            conn.execute(
                "INSERT INTO shift_expenses (
                    id, staff_shift_id, staff_id, branch_id, expense_type,
                    amount, amount_cents, description, receipt_number, status, sync_status,
                    created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, 'other', ?5, ?6, 'Fuel', NULL, 'pending', 'pending', ?7, ?7)",
                params![
                    "expense-driver-1",
                    driver_shift_id.as_str(),
                    "driver-1",
                    "branch-1",
                    5.0,
                    500_i64,
                    now.as_str()
                ],
            )
            .expect("insert driver expense");

            for (order_id, order_number, total_amount, status, payment_method) in [
                ("order-driver-cash", "#D1", 67.75, "completed", "cash"),
                ("order-driver-card", "#D2", 83.85, "completed", "card"),
                ("order-driver-refund", "#D3", 9.0, "refunded", "cash"),
            ] {
                // W4e Step 0: dual-populate via Cents::round_half_even.
                let total_amount_cents = Cents::round_half_even(total_amount).as_i64();
                conn.execute(
                    "INSERT INTO orders (
                        id, order_number, items, total_amount, total_amount_cents, status, order_type,
                        payment_status, staff_shift_id, delivery_address,
                        sync_status, created_at, updated_at
                    ) VALUES (?1, ?2, '[]', ?3, ?4, ?5, 'delivery',
                        'paid', ?6, 'Αλεξανδρείας 24', 'pending', ?7, ?7)",
                    params![
                        order_id,
                        order_number,
                        total_amount,
                        total_amount_cents,
                        status,
                        driver_shift_id.as_str(),
                        now.as_str()
                    ],
                )
                .expect("insert driver order");
                let _ = payment_method; // W6: method now derives from order_payments only
            }

            for (earning_id, order_id, payment_method, cash_collected, card_amount, tip_amount) in [
                (
                    "earning-driver-cash",
                    "order-driver-cash",
                    "cash",
                    67.75,
                    0.0,
                    2.5,
                ),
                (
                    "earning-driver-card",
                    "order-driver-card",
                    "card",
                    0.0,
                    83.85,
                    0.0,
                ),
                (
                    "earning-driver-refund",
                    "order-driver-refund",
                    "cash",
                    9.0,
                    0.0,
                    1.0,
                ),
            ] {
                // W4e Step 0: dual-populate driver_earnings cents siblings.
                let tip_amount_cents = Cents::round_half_even(tip_amount).as_i64();
                let cash_collected_cents = Cents::round_half_even(cash_collected).as_i64();
                let card_amount_cents = Cents::round_half_even(card_amount).as_i64();
                conn.execute(
                    "INSERT INTO driver_earnings (
                        id, driver_id, staff_shift_id, order_id, branch_id,
                        delivery_fee, delivery_fee_cents,
                        tip_amount, tip_amount_cents,
                        total_earning, total_earning_cents,
                        payment_method,
                        cash_collected, cash_collected_cents,
                        card_amount, card_amount_cents,
                        cash_to_return, cash_to_return_cents,
                        settled, created_at, updated_at
                    ) VALUES (
                        ?1, 'driver-1', ?2, ?3, 'branch-1',
                        0.0, 0, ?4, ?5, ?4, ?5, ?6,
                        ?7, ?8, ?9, ?10, ?7, ?8,
                        0, ?11, ?11
                    )",
                    params![
                        earning_id,
                        driver_shift_id.as_str(),
                        order_id,
                        tip_amount,
                        tip_amount_cents,
                        payment_method,
                        cash_collected,
                        cash_collected_cents,
                        card_amount,
                        card_amount_cents,
                        now.as_str()
                    ],
                )
                .expect("insert driver earnings");
            }

            conn.execute(
                "UPDATE staff_shifts
                 SET status = 'closed',
                     check_out_time = ?2,
                     closing_cash_amount = 87.75,
                     expected_cash_amount = 26.60,
                     cash_variance = 61.15
                 WHERE id = ?1",
                params![driver_shift_id.as_str(), now.as_str()],
            )
            .expect("close driver shift snapshot");
        }

        let doc = build_document_for_job(&db, "shift_checkout", &driver_shift_id, None).unwrap();
        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.role_type, "driver");
                assert_eq!(doc.expected_amount, Some(26.60));
                assert!((doc.total_cash_collected - 67.75).abs() < f64::EPSILON);
                assert!((doc.total_card_collected - 83.85).abs() < f64::EPSILON);
                assert!((doc.total_tips - 2.5).abs() < f64::EPSILON);
                assert!((doc.total_sells - 151.60).abs() < 0.0001);
                assert_eq!(doc.cancelled_or_refunded_count, 1);
                assert!((doc.cancelled_or_refunded_total - 9.0).abs() < f64::EPSILON);
                assert!((doc.amount_to_return - 80.25).abs() < 0.0001);
                assert_eq!(
                    doc.driver_deliveries[0].delivery_address.as_deref(),
                    Some("Αλεξανδρείας 24")
                );
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_z_report_payload_prefers_shift_count_and_terminal_name() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "terminal", "name", "Fallback Counter")
                .expect("set fallback terminal display name");
        }

        let payload = serde_json::json!({
            "date": "2026-03-15",
            "generatedAt": "2026-03-15T23:59:00Z",
            "shiftId": "shift-aggregate-1",
            "shiftCount": 4,
            "terminalId": "terminal-9bf9dfce",
            "terminalName": "Main POS",
            "sales": {
                "totalOrders": 11,
                "totalSales": 245.0,
                "cashSales": 120.0,
                "cardSales": 125.0
            },
            "cashDrawer": {
                "totalVariance": 0.0,
                "closing": 0.0,
                "moneyInDrawer": 325.02
            }
        });
        let raw_payload = payload.to_string();

        let doc = build_document_for_job(
            &db,
            "z_report",
            "snapshot-20260315",
            Some(raw_payload.as_str()),
        )
        .unwrap();
        match doc {
            ReceiptDocument::ZReport(doc) => {
                assert_eq!(doc.shift_ref, "");
                assert_eq!(doc.shift_count, Some(4));
                assert_eq!(doc.terminal_name, "Main POS");
                assert_eq!(doc.generated_at, "2026-03-15T23:59:00Z");
                assert_eq!(doc.closing_cash, 325.02);
            }
            _ => panic!("expected z-report document"),
        }
    }

    #[test]
    fn test_stored_z_report_prefers_physical_drawer_json_over_legacy_wallet_scalars() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, role_type, branch_id, terminal_id,
                    check_in_time, check_out_time, opening_cash_amount,
                    status, calculation_version, sync_status, created_at, updated_at
                ) VALUES (
                    'cashier-z-print', 'cashier-1', 'Angeliki', 'cashier',
                    'branch-1', 'term-1',
                    '2026-07-24T12:10:39Z', '2026-07-25T12:00:29Z', 137.64,
                    'closed', 2, 'pending',
                    '2026-07-24T12:10:39Z', '2026-07-25T12:00:29Z'
                )",
                [],
            )
            .expect("insert cashier shift");

            let report_json = serde_json::json!({
                "tips": { "total": 1.50 },
                "cashDrawer": {
                    "openingTotal": 137.64,
                    "cashSales": 170.55,
                    "totalRefunds": 0.10,
                    "totalExpenses": 242.00,
                    "staffPaymentsTotal": 36.00,
                    "driverCashGiven": 40.00,
                    "driverCashReturned": 119.55,
                    "expected": 109.64,
                    "moneyInDrawer": 131.74,
                    "totalVariance": 22.10
                }
            })
            .to_string();

            conn.execute(
                "INSERT INTO z_reports (
                    id, shift_id, branch_id, terminal_id, report_date, generated_at,
                    tips_total, cash_variance, opening_cash, closing_cash, expected_cash,
                    report_json, created_at, updated_at
                ) VALUES (
                    'z-print-wallet-bug', 'cashier-z-print', 'branch-1', 'term-1',
                    '2026-07-24', '2026-07-25T12:04:15Z',
                    0.0, 22.10, 177.64, 251.29, 229.19,
                    ?1, '2026-07-25T12:04:15Z', '2026-07-25T12:04:15Z'
                )",
                params![report_json],
            )
            .expect("insert legacy wallet-summed Z-report");
        }

        let doc = build_z_report_doc(&db, "z-print-wallet-bug").expect("build stored Z-report");
        assert_eq!(doc.opening_cash, 137.64);
        assert_eq!(doc.drawer_cash_sales, Some(170.55));
        assert_eq!(doc.expected_cash, 109.64);
        assert_eq!(doc.closing_cash, 131.74);
        assert_eq!(doc.cash_variance, 22.10);
        assert_eq!(doc.tips_total, 1.50);
    }

    #[test]
    fn test_receipt_like_entity_type_includes_shift_checkout_and_z_report() {
        assert!(is_receipt_like_entity_type("shift_checkout"));
        assert!(is_receipt_like_entity_type("z_report"));
    }

    #[test]
    fn test_build_order_receipt_doc_cash_uses_received_amount_and_change_only() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-cash-received", "ORD-CASH-1", 17.70);
            insert_order_payment(
                &conn,
                "pay-cash-received",
                "ord-cash-received",
                "cash",
                17.70,
                Some(20.00),
                Some(2.30),
                None,
            );
        }

        let doc = build_order_receipt_doc(&db, "ord-cash-received").unwrap();
        assert_eq!(doc.payments.len(), 2);
        assert_eq!(doc.payments[0].label, "Cash");
        assert!((doc.payments[0].amount - 20.00).abs() < 0.001);
        assert_eq!(doc.payments[1].label, "Change");
        assert!((doc.payments[1].amount - 2.30).abs() < 0.001);
        assert!(!doc.payments.iter().any(|line| line.label == "Received"));
    }

    #[test]
    fn test_build_order_receipt_doc_cash_falls_back_to_amount_without_received() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-cash-fallback", "ORD-CASH-2", 17.70);
            insert_order_payment(
                &conn,
                "pay-cash-fallback",
                "ord-cash-fallback",
                "cash",
                17.70,
                None,
                None,
                None,
            );
        }

        let doc = build_order_receipt_doc(&db, "ord-cash-fallback").unwrap();
        assert_eq!(doc.payments.len(), 1);
        assert_eq!(doc.payments[0].label, "Cash");
        assert!((doc.payments[0].amount - 17.70).abs() < 0.001);
        assert!(!doc.payments.iter().any(|line| line.label == "Received"));
    }

    // W6: the three `..._snapshot` regression tests (falls_back_to_paid_cash_order_snapshot,
    // falls_back_to_paid_card_order_snapshot_and_masked_card,
    // marks_unknown_snapshot_method_without_inventing_amount) covered the
    // stored-column fallback path that existed when a "paid" order had no
    // local `order_payments` rows. Post-v55 the `orders.payment_method`
    // column is gone and `derive_payment_method` returns None for that
    // case; the receipt falls through to no payment line. The behavior
    // they exercised is no longer expressible, so they were deleted.

    #[test]
    fn test_build_order_receipt_doc_card_keeps_amount_and_masked_card() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-card", "ORD-CARD-1", 17.70);
            insert_order_payment(
                &conn,
                "pay-card",
                "ord-card",
                "card",
                17.70,
                None,
                None,
                Some("txn-auth-****1234"),
            );
        }

        let doc = build_order_receipt_doc(&db, "ord-card").unwrap();
        assert_eq!(doc.payments.len(), 1);
        assert_eq!(doc.payments[0].label, "Card");
        assert!((doc.payments[0].amount - 17.70).abs() < 0.001);
        assert_eq!(doc.masked_card.as_deref(), Some("****1234"));
    }

    #[test]
    fn test_build_order_receipt_doc_card_skips_mock_transaction_ref() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-card-mock", "ORD-CARD-2", 12.60);
            insert_order_payment(
                &conn,
                "pay-card-mock",
                "ord-card-mock",
                "card",
                12.60,
                None,
                None,
                Some("mock-0215"),
            );
        }

        let doc = build_order_receipt_doc(&db, "ord-card-mock").unwrap();
        assert_eq!(doc.payments.len(), 1);
        assert_eq!(doc.payments[0].label, "Card");
        assert!(doc.masked_card.is_none());
    }

    #[test]
    fn test_build_order_receipt_doc_includes_discount_percentage_metadata() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (12.60/14.00/1.40 → 1260/1400/140).
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type,
                    discount_amount, discount_amount_cents, discount_percentage, sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-discount-percent', 'ORD-DISC-1', '[]', 12.60, 1260, 14.00, 1400, 'completed', 'pickup',
                    1.40, 140, 10.0, 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-discount-percent").unwrap();
        let subtotal_line = doc
            .totals
            .iter()
            .find(|line| line.label == "Subtotal")
            .expect("subtotal line");
        assert!((subtotal_line.amount - 14.00).abs() < 0.001);
        let discount_line = doc
            .totals
            .iter()
            .find(|line| line.label == "Discount")
            .expect("discount total line");
        assert!((discount_line.amount + 1.40).abs() < 0.001);
        assert_eq!(discount_line.discount_percent, Some(10.0));
    }

    #[test]
    fn test_build_order_receipt_doc_collects_item_and_order_notes() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (8.80 → 880).
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type,
                    delivery_notes, special_instructions, sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-notes', 'ORD-NOTES-1',
                    '[{\"name\":\"Waffle\",\"quantity\":1,\"total\":8.8,\"notes\":\"Well done\",\"special_instructions\":\"No sugar\"}]',
                    8.80, 880, 8.80, 880, 'completed', 'pickup',
                    'Use side door', 'Call on arrival', 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-notes").unwrap();
        assert_eq!(doc.order_notes, vec!["Use side door", "Call on arrival"]);
        assert_eq!(
            doc.items.first().and_then(|item| item.note.as_deref()),
            Some("Well done | No sugar")
        );
    }

    #[test]
    fn test_build_order_receipt_doc_backfills_category_path_from_menu_cache() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO menu_cache (cache_key, data, updated_at) VALUES (?1, ?2, datetime('now'))",
                params![
                    "categories",
                    r#"[{"id":"cat-sweet","name":"ΓΛΥΚΑ"}]"#
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO menu_cache (cache_key, data, updated_at) VALUES (?1, ?2, datetime('now'))",
                params![
                    "subcategories",
                    r#"[{"id":"sub-waffle","name":"Βάφλα","category_id":"cat-sweet"}]"#
                ],
            )
            .unwrap();
            // W4e Step 0: dual-populate (8.80 → 880).
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-category-backfill', 'ORD-CAT-1', ?1, 8.80, 880, 8.80, 880, 'completed', 'pickup',
                    'pending', datetime('now'), datetime('now')
                 )",
                params![r#"[{"menu_item_id":"sub-waffle","name":"Βάφλα","quantity":1,"total_price":8.8}]"#],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-category-backfill").unwrap();
        let first_item = doc.items.first().expect("order should include item");
        assert_eq!(first_item.category_name.as_deref(), Some("ΓΛΥΚΑ"));
        assert_eq!(first_item.subcategory_name.as_deref(), Some("Βάφλα"));
        assert_eq!(first_item.category_path.as_deref(), Some("ΓΛΥΚΑ > Βάφλα"));
    }

    #[test]
    fn test_resolve_layout_config_uses_restaurant_name_as_branch_subtitle_fallback() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "organization", "name", "The Small Group").unwrap();
            db::set_setting(&conn, "restaurant", "name", "Kifisia Branch").unwrap();
        }

        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "modern"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.organization_name, "The Small Group");
        assert_eq!(layout.store_subtitle.as_deref(), Some("Kifisia Branch"));
    }

    #[test]
    fn test_resolve_layout_config_skips_duplicate_branch_name_and_uses_org_subtitle() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "organization", "name", "The Small Group").unwrap();
            db::set_setting(&conn, "organization", "subtitle", "Head Office").unwrap();
            db::set_setting(&conn, "restaurant", "name", "The Small Group").unwrap();
        }

        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "modern"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.organization_name, "The Small Group");
        assert_eq!(layout.store_subtitle.as_deref(), Some("Head Office"));
    }

    #[test]
    fn test_resolve_layout_config_respects_profile_template() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.template, ReceiptTemplate::Classic);
    }

    #[test]
    fn test_resolve_layout_config_defaults_receipt_like_docs_to_classic_raster_exact() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80
        });

        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.template, ReceiptTemplate::Classic);
        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::RasterExact
        );
        assert_eq!(layout.font_type, FontType::A);
        assert_eq!(layout.layout_density, LayoutDensity::Compact);
        assert_eq!(layout.header_emphasis, HeaderEmphasis::Strong);
    }

    #[test]
    fn test_resolve_layout_config_kitchen_ticket_classic_locks_typography() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "fontType": "b",
            "layoutDensity": "spacious",
            "headerEmphasis": "normal"
        });

        let layout =
            resolve_layout_config(&db, &profile, "kitchen_ticket").expect("resolve layout config");

        assert_eq!(layout.template, ReceiptTemplate::Classic);
        assert_eq!(layout.font_type, FontType::A);
        assert_eq!(layout.layout_density, LayoutDensity::Compact);
        assert_eq!(layout.header_emphasis, HeaderEmphasis::Strong);
    }

    #[test]
    fn test_resolve_layout_config_classic_order_receipt_honors_typography_settings() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "fontType": "b",
            "layoutDensity": "spacious",
            "headerEmphasis": "normal"
        });

        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.template, ReceiptTemplate::Classic);
        assert_eq!(layout.font_type, FontType::B);
        assert_eq!(layout.layout_density, LayoutDensity::Spacious);
        assert_eq!(layout.header_emphasis, HeaderEmphasis::Normal);
    }

    #[test]
    fn test_resolve_layout_config_honors_template_override_setting() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "receipt", "template_override", "classic").unwrap();
        }

        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "modern"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.template, ReceiptTemplate::Classic);
    }

    #[test]
    fn test_resolve_layout_config_defaults_to_safe_text_for_star() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "printerName": "Star MCP31"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.command_profile, CommandProfile::SafeText);
    }

    #[test]
    fn test_resolve_layout_config_honors_command_profile_override() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "receipt", "command_profile", "full_style").unwrap();
        }

        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "modern",
            "printerName": "Star MCP31"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.command_profile, CommandProfile::FullStyle);
    }

    #[test]
    fn test_resolve_layout_config_reads_printer_typography_settings() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "modern",
            "fontType": "b",
            "layoutDensity": "spacious",
            "headerEmphasis": "normal",
            "printerName": "Star MCP31"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.font_type, FontType::B);
        assert_eq!(layout.layout_density, LayoutDensity::Spacious);
        assert_eq!(layout.header_emphasis, HeaderEmphasis::Normal);
    }

    #[test]
    fn test_resolve_layout_config_classic_receipt_normalizes_unsupported_euro_symbol() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "general", "language", "el").unwrap();
        }

        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "characterSet": "CP66_GREEK",
            "escposCodePage": 66,
            "printerName": "Generic Thermal Printer"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.currency_symbol, " EUR");
    }

    #[test]
    fn test_resolve_layout_config_reads_exact_mode_and_calibration_from_connection_json() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "printerName": "Star MCP31",
            "connectionJson": "{\"render_mode\":\"raster_exact\",\"emulation\":\"star_line\",\"printable_width_dots\":510,\"left_margin_dots\":12,\"threshold\":150}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::RasterExact
        );
        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::StarLine);
        assert_eq!(layout.printable_width_dots, 510);
        assert_eq!(layout.left_margin_dots, 12);
        assert_eq!(layout.raster_threshold, 150);
    }

    #[test]
    fn test_resolve_layout_config_uses_star_code_page_when_star_line_is_forced() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "192.168.1.19",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"emulation\":\"star_line\",\"capabilities\":{\"status\":\"verified\",\"resolvedTransport\":\"raw_tcp\",\"resolvedAddress\":\"192.168.1.19:9100\",\"emulation\":\"star_line\",\"renderMode\":\"text\",\"supportsCut\":true,\"supportsLogo\":false}}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::StarLine);
        assert_eq!(layout.escpos_code_page, Some(15));
    }

    #[test]
    fn test_resolve_layout_config_honors_explicit_star_line_without_capability_snapshot() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "LAN receipt printer",
            "printerType": "network",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"127.0.0.1:9\",\"emulation\":\"star_line\"}"
        });

        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::StarLine);
        assert_eq!(layout.escpos_code_page, Some(15));
    }

    #[test]
    fn test_resolve_layout_config_defaults_unverified_raw_network_to_escpos_text() {
        let db = test_db();
        // Star brand detected from printer name → should use Auto (not Escpos)
        // so that is_star_line_mode() returns true for Star printers.
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "Star MCP31 LAN",
            "printerType": "network",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\"}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::Auto);
        assert_eq!(layout.detected_brand, crate::printers::PrinterBrand::Star);
        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::Text
        );
        // Star code page 15 (PC737 Greek) instead of ESC/POS code page 14
        assert_eq!(layout.escpos_code_page, Some(15));
    }

    #[test]
    fn test_resolve_layout_config_honors_candidate_capability_snapshot_for_draft_tests() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "192.168.1.19",
            "printerType": "network",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"emulation\":\"auto\",\"render_mode\":\"raster_exact\",\"capabilities\":{\"status\":\"candidate\",\"resolvedTransport\":\"raw_tcp\",\"resolvedAddress\":\"192.168.1.19:9100\",\"emulation\":\"star_line\",\"renderMode\":\"text\",\"supportsCut\":true,\"supportsLogo\":false}}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::StarLine);
        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::Text
        );
        assert_eq!(layout.escpos_code_page, Some(15));
    }

    #[test]
    fn test_resolve_layout_config_keeps_unknown_network_on_escpos() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "127.0.0.1",
            "printerType": "network",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"127.0.0.1\",\"port\":9}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::Escpos);
        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::Text
        );
        assert_eq!(layout.escpos_code_page, Some(14));
    }

    #[test]
    fn test_resolve_layout_config_uses_standard_code_page_when_star_printer_forces_escpos() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "Star MCP31",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"system\",\"systemName\":\"Star MCP31\",\"emulation\":\"escpos\"}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::Escpos);
        assert_eq!(layout.escpos_code_page, Some(14));
    }

    #[test]
    fn test_resolve_layout_config_uses_full_80mm_width_for_mcp31_by_default() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "printerName": "Star MCP31L"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");
        assert_eq!(layout.printable_width_dots, 576);
    }

    #[test]
    fn test_resolve_layout_config_clamps_left_margin_when_width_is_full() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "connectionJson": "{\"render_mode\":\"raster_exact\",\"printable_width_dots\":576,\"left_margin_dots\":12}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");
        assert_eq!(layout.printable_width_dots, 576);
        assert_eq!(layout.left_margin_dots, 0);
    }

    #[test]
    fn test_body_boldness_default() {
        let db = test_db();
        let profile = serde_json::json!({});
        let layout = resolve_layout_config(&db, &profile, "order_receipt").unwrap();
        assert_eq!(layout.body_font_weight, 400);
    }

    #[test]
    fn test_body_boldness_level_3() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES (?1, ?2, ?3)",
                rusqlite::params!["receipt", "body_boldness", "3"],
            ).unwrap();
        }
        let profile = serde_json::json!({});
        let layout = resolve_layout_config(&db, &profile, "order_receipt").unwrap();
        assert_eq!(layout.body_font_weight, 600);
    }

    #[test]
    fn test_resolve_layout_config_keeps_logo_enabled_for_classic_raster_exact_receipts() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES (?1, ?2, ?3)",
                rusqlite::params!["receipt", "show_logo", "true"],
            )
            .unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES (?1, ?2, ?3)",
                rusqlite::params!["receipt", "logo_source", "data:image/png;base64,ZmFrZQ=="],
            )
            .unwrap();
        }
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "printerName": "Unknown Receipt",
            "connectionJson": "{\"type\":\"system\",\"systemName\":\"Unknown Receipt\",\"render_mode\":\"raster_exact\",\"capabilities\":{\"status\":\"unverified\",\"supportsLogo\":false}}"
        });
        let layout = resolve_layout_config(&db, &profile, "order_receipt").unwrap();

        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::RasterExact
        );
        assert!(
            layout.show_logo,
            "classic raster exact receipts should keep embedded logo enabled"
        );
    }

    #[test]
    fn test_body_boldness_in_html() {
        use crate::receipt_renderer::{
            render_html, LayoutConfig, OrderReceiptDoc, ReceiptDocument,
        };
        let cfg = LayoutConfig {
            body_font_weight: 700,
            ..Default::default()
        };
        let html = render_html(
            &ReceiptDocument::OrderReceipt(OrderReceiptDoc {
                order_id: "t".into(),
                order_number: "1".into(),
                order_type: "pickup".into(),
                status: "completed".into(),
                created_at: "2026-01-01".into(),
                ..Default::default()
            }),
            &cfg,
        );
        assert!(
            html.contains("font-weight: 700"),
            "HTML should contain body font-weight 700, got snippet: {}",
            &html[..500.min(html.len())]
        );
    }

    struct RecordingQueueInvalidator<'a> {
        db: &'a DbState,
        calls: AtomicUsize,
        committed_rows_seen: AtomicUsize,
    }

    impl<'a> RecordingQueueInvalidator<'a> {
        fn new(db: &'a DbState) -> Self {
            Self {
                db,
                calls: AtomicUsize::new(0),
                committed_rows_seen: AtomicUsize::new(0),
            }
        }
    }

    impl PrintQueueInvalidator for RecordingQueueInvalidator<'_> {
        fn invalidate_print_queue(&self) {
            let conn = self
                .db
                .conn
                .try_lock()
                .expect("enqueue must release the DB guard before invalidating");
            let committed_rows = conn
                .query_row("SELECT COUNT(*) FROM print_jobs", [], |row| {
                    row.get::<_, usize>(0)
                })
                .unwrap();
            assert!(
                committed_rows > 0,
                "the committed enqueue must be visible to the invalidator"
            );
            self.committed_rows_seen
                .store(committed_rows, Ordering::Release);
            self.calls.fetch_add(1, Ordering::AcqRel);
        }
    }

    #[test]
    fn committed_enqueue_invalidates_after_guard_release_even_while_paused() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(
                &conn,
                PRINT_QUEUE_SETTINGS_CATEGORY,
                PRINT_QUEUE_PAUSED_GLOBAL_KEY,
                "true",
            )
            .unwrap();
        }
        let invalidator = RecordingQueueInvalidator::new(&db);

        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-paused-invalidation",
            None,
            &invalidator,
        )
        .unwrap();

        assert_eq!(result["success"], true);
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 1);
        assert_eq!(invalidator.committed_rows_seen.load(Ordering::Acquire), 1);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE entity_id = 'ord-paused-invalidation'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "pending"
        );
    }

    #[test]
    fn enqueue_invalidation_is_exactly_once_only_for_committed_inserts() {
        let db = test_db();
        let invalidator = RecordingQueueInvalidator::new(&db);
        let payload = serde_json::json!({ "kind": "snapshot" });

        let first = enqueue_print_job_with_payload(
            &db,
            "z_report",
            "z-invalidation",
            None,
            Some(&payload),
            &invalidator,
        )
        .unwrap();
        assert_eq!(first["success"], true);
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 1);

        let duplicate = enqueue_print_job_with_payload(
            &db,
            "z_report",
            "z-invalidation",
            None,
            Some(&payload),
            &invalidator,
        )
        .unwrap();
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 1);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "CREATE TRIGGER reject_invalidation_enqueue
                 BEFORE INSERT ON print_jobs
                 WHEN NEW.entity_id = 'reject-invalidation'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced enqueue failure');
                 END;",
            )
            .unwrap();
        }
        assert!(
            enqueue_print_job(&db, "z_report", "reject-invalidation", None, &invalidator,).is_err()
        );
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 1);

        assert!(enqueue_print_job(
            &db,
            "invalid_entity",
            "invalid-invalidation",
            None,
            &invalidator,
        )
        .is_err());
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 1);

        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-sandbox-invalidation", "TEST-2", 1.0);
            conn.execute(
                "UPDATE orders
                 SET integration_environment = 'sandbox', is_test = 1
                 WHERE id = 'ord-sandbox-invalidation'",
                [],
            )
            .unwrap();
        }
        let sandbox = enqueue_print_job(
            &db,
            "kitchen_ticket",
            "ord-sandbox-invalidation",
            None,
            &invalidator,
        )
        .unwrap();
        assert_eq!(sandbox["skipped"], true);
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 1);

        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT entity_payload_json FROM print_jobs WHERE id = ?1",
                [first["jobId"].as_str().unwrap()],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            serde_json::to_string(&payload).unwrap()
        );
    }

    #[test]
    fn test_enqueue_and_list() {
        let db = test_db();

        // Enqueue a job
        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-1",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        assert_eq!(result["success"], true);
        let job_id = result["jobId"].as_str().unwrap().to_string();

        // List all jobs
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["entityId"], "ord-1");
        assert_eq!(arr[0]["status"], "pending");

        // List pending jobs
        let pending = list_print_jobs(&db, Some("pending")).unwrap();
        assert_eq!(pending.as_array().unwrap().len(), 1);

        // List printed jobs (should be empty)
        let printed = list_print_jobs(&db, Some("printed")).unwrap();
        assert_eq!(printed.as_array().unwrap().len(), 0);

        // Verify idempotency — enqueue same entity again
        let dup = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-1",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        assert_eq!(dup["success"], true);
        assert_eq!(dup["duplicate"], true);
        assert_eq!(dup["jobId"], job_id);

        // Total jobs should still be 1
        let jobs2 = list_print_jobs(&db, None).unwrap();
        assert_eq!(jobs2.as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_sandbox_order_never_enters_production_print_queue() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-sandbox", "TEST-1", 12.50);
            conn.execute(
                "UPDATE orders
                 SET integration_environment = 'sandbox', is_test = 1
                 WHERE id = 'ord-sandbox'",
                [],
            )
            .unwrap();
        }

        let result = enqueue_print_job(
            &db,
            "kitchen_ticket",
            "ord-sandbox",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();

        assert_eq!(result["success"], true);
        assert_eq!(result["skipped"], true);
        assert_eq!(result["reason"], "sandbox_order");
        assert!(list_print_jobs(&db, None)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn faithful_platform_slip_headlines_the_short_code() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-efood-slip", "EFOOD-1787677685257-64656281", 2.6);
            conn.execute(
                r#"UPDATE orders
                   SET plugin = 'efood',
                       external_plugin_order_id = '64656281',
                       ghost_metadata = '{"food_delivery":{"short_code":"20","payment_method":"cash","prepaid":false,"delivery_provider":"vendor_delivery"}}'
                   WHERE id = 'ord-efood-slip'"#,
                [],
            )
            .unwrap();
        }

        // The receipt mirrors efood's own slip: the 4-digit rider code is the
        // big number, the long platform id becomes the footer line.
        let doc = build_order_receipt_doc(&db, "ord-efood-slip").unwrap();
        assert_eq!(doc.order_number, "20");
        assert!(doc
            .order_notes
            .iter()
            .any(|note| note == "ΚΩΔΙΚΟΣ ΠΑΡΑΓΓΕΛΙΑΣ: 64656281"));
        let label = doc.status_label.unwrap_or_default();
        assert!(label.contains("EFOOD #20"), "banner missing: {label}");
        assert!(label.contains("ΑΝΤΙΚΑΤΑΒΟΛΗ"), "COD line missing: {label}");

        // The kitchen matches bags to riders by the same code.
        let kitchen = build_kitchen_ticket_doc(&db, "ord-efood-slip").unwrap();
        assert_eq!(kitchen.order_number, "20");
    }

    #[test]
    fn test_receipt_doc_carries_the_platform_slip_facts() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-efood-slip", "EFOOD-1787-64656368", 20.30);
            conn.execute(
                "UPDATE orders
                 SET plugin = 'efood', external_plugin_order_id = '64656368',
                     ghost_metadata = '{\"food_delivery\":{\"short_code\":\"4579\",\"payment_method\":\"cash\",\"prepaid\":false,\"delivery_provider\":\"platform_delivery\"}}'
                 WHERE id = 'ord-efood-slip'",
                [],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-efood-slip").unwrap();
        let slip = doc
            .platform_slip
            .expect("platform order must carry slip facts");
        assert_eq!(slip.plugin, "efood");
        assert_eq!(slip.short_code.as_deref(), Some("4579"));
        assert_eq!(slip.external_order_id.as_deref(), Some("64656368"));
        assert_eq!(slip.payment_method.as_deref(), Some("cash"));
        assert!(!slip.prepaid);
        assert_eq!(slip.delivery_provider.as_deref(), Some("platform_delivery"));

        // A plain local order stays on the standard receipt layout.
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-local-slip", "ORD-1", 5.0);
        }
        let doc = build_order_receipt_doc(&db, "ord-local-slip").unwrap();
        assert!(doc.platform_slip.is_none());
    }

    #[test]
    fn test_receipt_doc_survives_integer_estimated_time_from_the_accept_flow() {
        // order_approve stores the accept's prep minutes as an INTEGER
        // (`estimated_time INTEGER` column + i64 param). The doc SELECT used
        // to read that column as TEXT, so every accepted platform order died
        // at render with a misleading "Order not found" while regular orders
        // (NULL estimated_time → '') kept printing — the exact "only efood
        // fails" field pattern of 28/08.
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-efood-eta", "EFOOD-1787-64656473", 12.60);
            conn.execute(
                "UPDATE orders
                 SET plugin = 'efood', external_plugin_order_id = '64656473',
                     estimated_time = 25,
                     ghost_metadata = '{\"food_delivery\":{\"short_code\":\"4590\",\"payment_method\":\"card\",\"prepaid\":true,\"delivery_provider\":\"platform_delivery\"}}'
                 WHERE id = 'ord-efood-eta'",
                [],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-efood-eta")
            .expect("integer prep minutes must not kill the render");
        let slip = doc
            .platform_slip
            .expect("accepted platform order must carry slip facts");
        assert!(
            slip.ready_at.is_some(),
            "prep minutes must produce the promised-ready time"
        );
    }

    #[test]
    fn test_print_sandbox_orders_override_lets_test_slips_through() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-sandbox-ovr", "TEST-9", 4.20);
            conn.execute(
                "UPDATE orders
                 SET integration_environment = 'sandbox', is_test = 1
                 WHERE id = 'ord-sandbox-ovr'",
                [],
            )
            .unwrap();
            crate::db::set_setting(&conn, "receipt_actions", "print_sandbox_orders", "true")
                .unwrap();
        }

        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-sandbox-ovr",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        assert_eq!(result["success"], true);
        assert!(result.get("skipped").is_none() || result["skipped"] != true);
        assert_eq!(
            list_print_jobs(&db, None)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // The slip itself is branded as a test document.
        let doc = build_order_receipt_doc(&db, "ord-sandbox-ovr").unwrap();
        let label = doc.status_label.unwrap_or_default();
        assert!(
            label.starts_with("ΔΟΚΙΜΗ TEST"),
            "sandbox slip must carry the test banner, got: {label}"
        );

        // Flipping the override back off restores the production guard.
        {
            let conn = db.conn.lock().unwrap();
            crate::db::set_setting(&conn, "receipt_actions", "print_sandbox_orders", "false")
                .unwrap();
            conn.execute("DELETE FROM print_jobs", []).unwrap();
        }
        let blocked = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-sandbox-ovr",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        assert_eq!(blocked["skipped"], true);
    }

    #[test]
    fn test_enqueue_with_payload_persists_snapshot_json() {
        let db = test_db();
        let payload = serde_json::json!({
            "date": "2026-02-24",
            "sales": { "totalSales": 123.45 }
        });
        let result = enqueue_print_job_with_payload(
            &db,
            "z_report",
            "snapshot-20260224",
            None,
            Some(&payload),
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        assert_eq!(result["success"], true);
        let job_id = result["jobId"].as_str().unwrap().to_string();

        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        let job = arr.iter().find(|value| value["id"] == job_id).unwrap();
        assert!(job.get("entityPayloadJson").is_none());
        let conn = db.conn.lock().unwrap();
        assert!(conn
            .query_row(
                "SELECT entity_payload_json FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
            .contains("\"date\""));
    }

    #[test]
    fn test_mark_dispatched() {
        let db = test_db();

        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-2",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        mark_print_job_dispatched(&db, job_id, "/tmp/receipt.html").unwrap();

        let jobs = list_print_jobs(&db, Some("dispatched")).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert!(arr[0].get("outputPath").is_none());
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT output_path FROM print_jobs WHERE id = ?1",
                [job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "/tmp/receipt.html"
        );
        assert_terminal_parent_history(&conn, job_id, "dispatched");
    }

    #[test]
    fn test_mark_failed_with_retry() {
        let db = test_db();

        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-3",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        // First failure — should stay pending (retry_count < max_retries)
        mark_job_printing_for_test(&db, job_id);
        mark_print_job_failed(&db, job_id, "printer offline").unwrap();

        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr[0]["retryCount"], 1);
        assert_eq!(arr[0]["status"], "pending");
        assert_eq!(arr[0]["lastError"], "printer offline");
        {
            let conn = db.conn.lock().unwrap();
            assert_parent_history_is_clear(&conn, job_id, "pending");
        }

        // Second failure
        mark_job_printing_for_test(&db, job_id);
        mark_print_job_failed(&db, job_id, "still offline").unwrap();
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr[0]["retryCount"], 2);
        assert_eq!(arr[0]["status"], "pending");
        {
            let conn = db.conn.lock().unwrap();
            assert_parent_history_is_clear(&conn, job_id, "pending");
        }

        // Third failure — should move to failed (max_retries=3)
        mark_job_printing_for_test(&db, job_id);
        mark_print_job_failed(&db, job_id, "gave up").unwrap();
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr[0]["retryCount"], 3);
        assert_eq!(arr[0]["status"], "failed");
        let conn = db.conn.lock().unwrap();
        assert_terminal_parent_history(&conn, job_id, "failed");
    }

    #[test]
    fn non_retryable_and_managed_preparation_failures_store_terminal_history() {
        let db = test_db();
        let non_retryable = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-terminal-non-retryable",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap()["jobId"]
            .as_str()
            .unwrap()
            .to_owned();
        let preparation = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-terminal-preparation",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap()["jobId"]
            .as_str()
            .unwrap()
            .to_owned();

        mark_job_printing_for_test(&db, &non_retryable);
        mark_print_job_failed_non_retryable(&db, &non_retryable, "ambiguous output").unwrap();
        mark_managed_preparation_failed(&db, &preparation, "invalid frozen document");

        let conn = db.conn.lock().unwrap();
        assert_terminal_parent_history(&conn, &non_retryable, "failed");
        assert_terminal_parent_history(&conn, &preparation, "failed");
    }

    #[test]
    fn cancelled_job_is_not_resurrected_by_late_retryable_failure() {
        let db = test_db();
        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-cancel-race",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        assert_eq!(cancel_print_job(&db, job_id).unwrap()["success"], true);
        mark_print_job_failed(&db, job_id, "network write failed").unwrap();

        let jobs = list_print_jobs(&db, None).unwrap();
        let job = &jobs.as_array().unwrap()[0];
        assert_eq!(job["status"], "cancelled");
        assert_eq!(job["retryCount"], 0);
    }

    #[test]
    fn cancelled_job_is_not_overwritten_by_late_non_retryable_failure() {
        let db = test_db();
        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-cancel-race-final",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        assert_eq!(cancel_print_job(&db, job_id).unwrap()["success"], true);
        mark_print_job_failed_non_retryable(&db, job_id, "raw print state is unknown").unwrap();

        let jobs = list_print_jobs(&db, None).unwrap();
        let job = &jobs.as_array().unwrap()[0];
        assert_eq!(job["status"], "cancelled");
        assert_eq!(job["retryCount"], 0);
    }

    #[test]
    fn contention_cleanup_failure_does_not_fail_parent_owned_by_winner() {
        let db = test_db();
        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "contention-winner",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        let job_id = result["jobId"].as_str().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs SET status = 'printing' WHERE id = ?1",
                [job_id],
            )
            .unwrap();
        }

        handle_managed_preparation_failure(
            &db,
            job_id,
            &ManagedPreparationFailure::ClaimLostCleanup(
                "remove owned provisional artifact".into(),
            ),
        );

        let conn = db.conn.lock().unwrap();
        let parent: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, last_error FROM print_jobs WHERE id = ?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(parent, ("printing".into(), 0, None));
    }

    #[test]
    fn duplicate_active_registration_coalesces_original_token_until_last_guard() {
        let db = test_db();
        let original =
            ActivePrintGuard::register(&db, "duplicate-active-job", Some("profile-a".into()))
                .unwrap();
        let duplicate =
            ActivePrintGuard::register(&db, "duplicate-active-job", Some("profile-a".into()))
                .unwrap();

        assert!(Arc::ptr_eq(
            &original.cancel_token(),
            &duplicate.cancel_token()
        ));
        drop(duplicate);
        assert_eq!(
            request_active_print_stops(&db, Some("duplicate-active-job"), None).unwrap(),
            1
        );
        assert!(original.cancel_requested());
        drop(original);
        assert_eq!(
            request_active_print_stops(&db, Some("duplicate-active-job"), None).unwrap(),
            0
        );
    }

    #[test]
    fn dropping_duplicate_removes_only_its_profile_membership() {
        let db = test_db();
        let original =
            ActivePrintGuard::register(&db, "profile-membership-job", Some("profile-a".into()))
                .unwrap();
        let duplicate =
            ActivePrintGuard::register(&db, "profile-membership-job", Some("profile-b".into()))
                .unwrap();

        drop(duplicate);

        assert_eq!(
            request_active_print_stops(&db, None, Some("profile-b")).unwrap(),
            0
        );
        assert!(!original.cancel_requested());
        assert_eq!(
            request_active_print_stops(&db, None, Some("profile-a")).unwrap(),
            1
        );
        assert!(original.cancel_requested());
    }

    struct BlockingCancellableManagedRaw {
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
        writes: AtomicUsize,
    }

    impl ManagedRawTransport for BlockingCancellableManagedRaw {
        fn send(
            &self,
            _db: &DbState,
            _target: &printers::ResolvedPrinterTarget,
            bytes: &[u8],
            _document_name: &str,
            cancel: &AtomicBool,
        ) -> Result<printers::RawPrintResult, printers::RawTransportFailure> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            self.entered.send(()).unwrap();
            let release = self.release.lock().unwrap().take().unwrap();
            let _ = release.recv();
            if cancel.load(Ordering::Acquire) {
                return Err(printers::RawTransportFailure {
                    kind: printers::RawTransportFailureKind::AmbiguousAfterWrite,
                    bytes_requested: bytes.len(),
                    bytes_written: 1,
                    message: "cancelled before second fake write".into(),
                });
            }
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(printers::RawPrintResult {
                bytes_requested: bytes.len(),
                bytes_written: bytes.len(),
                doc_name: "overlap".into(),
                spool_job_id: None,
            })
        }
    }

    #[derive(Clone, Copy)]
    enum OverlappingCancelKind {
        Job,
        Profile,
    }

    fn assert_overlapping_tick_cancel_targets_original(kind: OverlappingCancelKind) {
        let db = Arc::new(test_db());
        let manager = Arc::new(DispatchManager::isolated_for_test());
        let job_id = Uuid::new_v4().to_string();
        let profile_id = "overlap-profile";
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "overlap-order", "OVERLAP-1", 9.0);
            insert_managed_network_profile(&conn, profile_id, "overlap.local", 9100, true);
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'overlap-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }
        let data_dir = std::env::temp_dir().join(format!("managed-overlap-{}", Uuid::new_v4()));
        let (raw_entered_tx, raw_entered_rx) = std::sync::mpsc::channel();
        let (raw_release_tx, raw_release_rx) = std::sync::mpsc::channel();
        let raw = Arc::new(BlockingCancellableManagedRaw {
            entered: raw_entered_tx,
            release: Mutex::new(Some(raw_release_rx)),
            writes: AtomicUsize::new(0),
        });
        let (a_registered_tx, a_registered_rx) = std::sync::mpsc::channel();
        let (a_continue_tx, a_continue_rx) = std::sync::mpsc::channel();
        let (a_token_tx, a_token_rx) = std::sync::mpsc::channel();
        let a_db = Arc::clone(&db);
        let a_manager = Arc::clone(&manager);
        let a_raw = Arc::clone(&raw);
        let a_job_id = job_id.clone();
        let a_data_dir = data_dir.clone();
        let a_worker = std::thread::spawn(move || -> Result<(), String> {
            let attempt = prepare_frozen_attempt_with_profile_hooks(
                &a_db,
                &a_data_dir,
                &a_manager,
                &a_job_id,
                "order_receipt",
                "overlap-order",
                None,
                None,
                &|_| {},
                &|_| {
                    a_registered_tx.send(()).unwrap();
                    a_continue_rx.recv().unwrap();
                },
            )?
            .ok_or("tick A did not prepare its attempt")?;
            a_token_tx.send(attempt.active.cancel_token()).unwrap();
            execute_raw_attempt(
                &a_db,
                &a_manager,
                a_raw.as_ref(),
                &FakeManagedDrawer::default(),
                attempt,
            )
        });
        a_registered_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap();

        let (b_registered_tx, b_registered_rx) = std::sync::mpsc::channel();
        let (b_continue_tx, b_continue_rx) = std::sync::mpsc::channel();
        let b_db = Arc::clone(&db);
        let b_manager = Arc::clone(&manager);
        let b_job_id = job_id.clone();
        let b_data_dir = data_dir.clone();
        let b_worker = std::thread::spawn(move || {
            prepare_frozen_attempt_with_profile_hooks(
                &b_db,
                &b_data_dir,
                &b_manager,
                &b_job_id,
                "order_receipt",
                "overlap-order",
                None,
                None,
                &|_| {},
                &|_| {
                    b_registered_tx.send(()).unwrap();
                    b_continue_rx.recv().unwrap();
                },
            )
        });
        b_registered_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap();

        a_continue_tx.send(()).unwrap();
        let original_token = a_token_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        raw_entered_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        b_continue_tx.send(()).unwrap();
        assert!(matches!(b_worker.join().unwrap(), Ok(None)));

        let cancellation = match kind {
            OverlappingCancelKind::Job => cancel_print_job(&db, &job_id).unwrap(),
            OverlappingCancelKind::Profile => {
                pause_and_cancel_pos_jobs(&db, Some(profile_id), None).unwrap()
            }
        };
        let token_was_cancelled = original_token.load(Ordering::Acquire);
        let _ = raw_release_tx.send(());
        a_worker.join().unwrap().unwrap();

        assert_eq!(cancellation["affected"], 1);
        assert_eq!(cancellation["activeStopsRequested"], 1);
        assert!(token_was_cancelled);
        assert_eq!(raw.writes.load(Ordering::SeqCst), 1);
        let conn = db.conn.lock().unwrap();
        let parent: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, last_error FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            parent,
            ("failed".into(), 1, Some(MANUAL_RECOVERY_ERROR.to_string()))
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT state FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "unknown"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn overlapping_same_job_ticks_preserve_original_token_for_job_cancel() {
        assert_overlapping_tick_cancel_targets_original(OverlappingCancelKind::Job);
    }

    #[test]
    fn overlapping_same_job_ticks_preserve_original_token_for_profile_cancel() {
        assert_overlapping_tick_cancel_targets_original(OverlappingCancelKind::Profile);
    }

    #[test]
    fn duplicate_tick_cannot_bypass_retry_backoff_after_primary_prewrite_failure() {
        let db = Arc::new(test_db());
        let manager = Arc::new(DispatchManager::isolated_for_test());
        let job_id = Uuid::new_v4().to_string();
        let data_dir = std::env::temp_dir().join(format!(
            "managed-duplicate-retry-backoff-{}",
            Uuid::new_v4()
        ));
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "duplicate-retry-order", "DR-1", 2.5);
            insert_managed_network_profile(
                &conn,
                "duplicate-retry-profile",
                "prewrite.local",
                9100,
                true,
            );
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'duplicate-retry-order', 'pending', datetime('now'), datetime('now'))",
                [&job_id],
            )
            .unwrap();
        }

        let (a_registered_tx, a_registered_rx) = std::sync::mpsc::channel();
        let (a_continue_tx, a_continue_rx) = std::sync::mpsc::channel();
        let a_db = Arc::clone(&db);
        let a_manager = Arc::clone(&manager);
        let a_job_id = job_id.clone();
        let a_data_dir = data_dir.clone();
        let a_worker = std::thread::spawn(move || -> Result<(), String> {
            let attempt = prepare_frozen_attempt_with_profile_hooks(
                &a_db,
                &a_data_dir,
                &a_manager,
                &a_job_id,
                "order_receipt",
                "duplicate-retry-order",
                None,
                None,
                &|_| {},
                &|_| {
                    a_registered_tx.send(()).unwrap();
                    a_continue_rx.recv().unwrap();
                },
            )?
            .ok_or("primary tick did not prepare an attempt")?;
            execute_raw_attempt(
                &a_db,
                &a_manager,
                &ClassifiedFailureRaw,
                &FakeManagedDrawer::default(),
                attempt,
            )
        });
        a_registered_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap();

        let (b_registered_tx, b_registered_rx) = std::sync::mpsc::channel();
        let (b_continue_tx, b_continue_rx) = std::sync::mpsc::channel();
        let b_db = Arc::clone(&db);
        let b_manager = Arc::clone(&manager);
        let b_job_id = job_id.clone();
        let b_data_dir = data_dir.clone();
        let b_worker = std::thread::spawn(move || {
            prepare_frozen_attempt_with_profile_hooks(
                &b_db,
                &b_data_dir,
                &b_manager,
                &b_job_id,
                "order_receipt",
                "duplicate-retry-order",
                None,
                None,
                &|_| {},
                &|_| {
                    b_registered_tx.send(()).unwrap();
                    b_continue_rx.recv().unwrap();
                },
            )
        });
        b_registered_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap();

        a_continue_tx.send(()).unwrap();
        a_worker.join().unwrap().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            let parent: (String, i64, Option<String>) = conn
                .query_row(
                    "SELECT status, retry_count, next_retry_at FROM print_jobs WHERE id = ?1",
                    [&job_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(parent.0, "pending");
            assert_eq!(parent.1, 1);
            assert!(parent.2.is_some());
        }

        b_continue_tx.send(()).unwrap();
        assert!(matches!(b_worker.join().unwrap(), Ok(None)));
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        drop(conn);
        assert_eq!(
            std::fs::read_dir(data_dir.join(RECEIPTS_DIR))
                .unwrap()
                .count(),
            1
        );
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn pausing_queue_requests_stop_for_active_hardware_dispatch() {
        let db = test_db();
        let active = ActivePrintGuard::register(
            &db,
            "active-pause-job",
            Some("receipt-printer".to_string()),
        )
        .unwrap();

        let result = set_print_queue_paused(&db, None, true).unwrap();

        assert_eq!(result["activeStopsRequested"], 1);
        assert!(active.cancel_requested());
    }

    #[test]
    fn active_print_registry_isolates_live_db_owners_and_exact_guard_drop() {
        let db_a = test_db();
        let db_b = test_db();
        let owner_a = active_print_owner_id(&db_a).unwrap();
        let owner_b = active_print_owner_id(&db_b).unwrap();
        assert_ne!(owner_a, owner_b);
        assert_eq!(owner_a, active_print_owner_id(&db_a).unwrap());

        let guard_a =
            ActivePrintGuard::register(&db_a, "shared-active-job", Some("shared-profile".into()))
                .unwrap();
        let guard_b =
            ActivePrintGuard::register(&db_b, "shared-active-job", Some("shared-profile".into()))
                .unwrap();

        assert_eq!(
            request_active_print_stops(&db_a, None, Some("shared-profile")).unwrap(),
            1
        );
        assert!(guard_a.cancel_requested());
        assert!(!guard_b.cancel_requested());

        drop(guard_a);
        assert_eq!(
            request_active_print_stops(&db_b, Some("shared-active-job"), None).unwrap(),
            1
        );
        assert!(guard_b.cancel_requested());
    }

    #[test]
    fn cancelling_job_requests_stop_for_its_active_hardware_dispatch() {
        let db = test_db();
        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-active-cancel",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        let job_id = result["jobId"].as_str().unwrap().to_owned();
        let sibling_id =
            insert_control_job(&db.conn.lock().unwrap(), "printing", Some("profile-a"));
        let stale_id = insert_control_job(&db.conn.lock().unwrap(), "printing", Some("profile-a"));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs SET status = 'printing' WHERE id = ?1",
                params![job_id],
            )
            .unwrap();
        }
        let active = ActivePrintGuard::register(&db, &job_id, Some("profile-a".into())).unwrap();
        let sibling =
            ActivePrintGuard::register(&db, &sibling_id, Some("profile-a".into())).unwrap();
        let other_db = test_db();
        let other_owner_same_job =
            ActivePrintGuard::register(&other_db, &job_id, Some("profile-a".into())).unwrap();

        let before = print_queue_snapshot(&db, None, None, 20, 0).unwrap();
        assert!(
            before
                .jobs
                .iter()
                .find(|job| job.id == job_id)
                .unwrap()
                .capabilities
                .cancellable
        );
        assert!(
            !before
                .jobs
                .iter()
                .find(|job| job.id == stale_id)
                .unwrap()
                .capabilities
                .cancellable
        );

        let spooler = Arc::new(FakeWindowsSpooler::new(73));
        let response = cancel_print_job_with_spooler(
            &db,
            &job_id,
            Arc::clone(&spooler),
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(response["success"], true);
        assert_eq!(response["durableChanged"], false);
        assert_eq!(response["affected"], 1);
        assert_eq!(response["unchanged"], 0);
        assert_eq!(response["localCancelled"], 0);
        assert_eq!(response["activeStopsRequested"], 1);
        assert_eq!(response["nativeControlsRequested"], 0);
        assert!(spooler.controls().is_empty());

        assert!(active.cancel_requested());
        assert!(!sibling.cancel_requested());
        assert!(!other_owner_same_job.cancel_requested());
        let conn = db.conn.lock().unwrap();
        let parent: (
            String,
            Option<i64>,
            Option<Vec<u8>>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT status, document_snapshot_version, document_snapshot_zlib,
                        document_snapshot_sha256, render_profile_snapshot_json, output_path
                 FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(parent, ("printing".into(), None, None, None, None, None));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&sibling_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "printing"
        );
        assert!(!is_print_queue_paused_with_conn(&conn, None));
        assert!(!is_print_queue_paused_with_conn(&conn, Some("profile-a")));
    }

    #[test]
    fn pending_pre_attempt_cancel_is_durable_and_requests_only_the_exact_live_token() {
        let db = test_db();
        let job_id = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-pre-attempt",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap()["jobId"]
            .as_str()
            .unwrap()
            .to_owned();
        let sibling_id = insert_control_job(&db.conn.lock().unwrap(), "pending", Some("profile-a"));
        let active = ActivePrintGuard::register(&db, &job_id, Some("profile-a".into())).unwrap();
        let sibling =
            ActivePrintGuard::register(&db, &sibling_id, Some("profile-a".into())).unwrap();
        let other_db = test_db();
        let other_owner_same_job =
            ActivePrintGuard::register(&other_db, &job_id, Some("profile-a".into())).unwrap();
        let spooler = Arc::new(FakeWindowsSpooler::new(73));

        let response = cancel_print_job_with_spooler(
            &db,
            &job_id,
            Arc::clone(&spooler),
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(response["success"], true);
        assert_eq!(response["durableChanged"], true);
        assert_eq!(response["affected"], 1);
        assert_eq!(response["unchanged"], 0);
        assert_eq!(response["localCancelled"], 1);
        assert_eq!(response["activeStopsRequested"], 1);
        assert_eq!(response["nativeControlsRequested"], 0);
        assert!(spooler.controls().is_empty());
        assert!(active.cancel_requested());
        assert!(!sibling.cancel_requested());
        assert!(!other_owner_same_job.cancel_requested());

        let conn = db.conn.lock().unwrap();
        let parent: (
            String,
            Option<i64>,
            Option<Vec<u8>>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT status, document_snapshot_version, document_snapshot_zlib,
                        document_snapshot_sha256, render_profile_snapshot_json, output_path
                 FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(parent, ("cancelled".into(), None, None, None, None, None));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_job_attempts WHERE print_job_id = ?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&sibling_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "pending"
        );
        assert!(!is_print_queue_paused_with_conn(&conn, None));
        assert!(!is_print_queue_paused_with_conn(&conn, Some("profile-a")));
    }

    #[test]
    fn cancelling_active_executor_keeps_parent_honest_and_releases_lane_after_pre_io_stop() {
        let db = test_db();
        let (job_id, attempt) = {
            let conn = db.conn.lock().unwrap();
            let job_id = insert_control_job(&conn, "printing", Some("profile-active"));
            let attempt = create_attempt(
                &conn,
                NewAttempt {
                    local_job_id: job_id.clone(),
                    target: PrinterTargetKey::RawTcp {
                        host: "active.local".into(),
                        port: 9100,
                    },
                    document_kind: "receipt".into(),
                    bytes_requested: 10,
                    now: Utc::now(),
                },
            )
            .unwrap();
            transition_attempt(
                &conn,
                attempt.attempt_id,
                DispatchState::Submitting,
                AttemptObservation::default(),
            )
            .unwrap();
            (job_id, attempt)
        };
        let manager = DispatchManager::isolated_for_test();
        let mut lease = manager.claim(attempt.target_key.clone()).unwrap();
        let active =
            ActivePrintGuard::register(&db, &job_id, Some("profile-active".into())).unwrap();

        let result = cancel_print_job(&db, &job_id).unwrap();

        assert_eq!(result["success"], true);
        assert_eq!(result["durableChanged"], false);
        assert_eq!(result["localCancelled"], 0);
        assert_eq!(result["activeStopsRequested"], 1);
        assert!(active.cancel_requested());
        {
            let conn = db.conn.lock().unwrap();
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
                crate::print_dispatch::read_attempt(&conn, attempt.attempt_id)
                    .unwrap()
                    .unwrap()
                    .state,
                DispatchState::Submitting
            );
            assert_eq!(
                cancel_managed_submission_before_io(&conn, attempt.attempt_id, Utc::now(),)
                    .unwrap(),
                ApplyResult::Applied
            );
        }
        lease.release_unstarted();
        drop(lease);
        assert!(manager.claim(attempt.target_key).is_ok());
    }

    #[test]
    fn test_z_report_expense_entries_preserve_each_reason() {
        let entries = z_report_expense_entries(&serde_json::json!({
            "expenses": {
                "total": 18.0,
                "items": [
                    {
                        "expenseType": "supplies",
                        "amount": 12.0,
                        "description": "Cleaning supplies",
                        "createdAt": "2026-07-23T12:00:00Z"
                    },
                    {
                        "expenseType": "transport",
                        "amount": 6.0,
                        "description": "Taxi for stock",
                        "createdAt": "2026-07-23T14:00:00Z"
                    }
                ]
            }
        }));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].reason, "Cleaning supplies");
        assert_eq!(entries[0].expense_type, "supplies");
        assert_eq!(entries[0].amount, 12.0);
        assert_eq!(entries[1].reason, "Taxi for stock");
        assert_eq!(entries[1].amount, 6.0);
    }

    #[test]
    fn test_z_report_expense_entries_keep_missing_reason_empty_for_localization() {
        let entries = z_report_expense_entries(&serde_json::json!({
            "expenses": {
                "items": [{
                    "amount": 5.0
                }]
            }
        }));

        assert_eq!(entries.len(), 1);
        assert!(entries[0].reason.is_empty());
    }

    #[test]
    fn test_z_report_staff_payment_entries_are_itemized_named_and_deduplicated() {
        let entries = z_report_staff_payment_entries(&serde_json::json!({
            "staffReports": [
                {
                    "staffName": "Maria",
                    "role": "cashier",
                    "payments": {
                        "staffPayments": 34.0,
                        "list": [{
                            "id": "staff-payment-1",
                            "amount": 34.0,
                            "type": "salary_advance",
                            "notes": "Friday advance",
                            "staffName": "Alex",
                            "role": "driver",
                            "createdAt": "2026-07-23T15:00:00Z"
                        }]
                    }
                },
                {
                    "staffName": "Alex",
                    "role": "driver",
                    "payments": {
                        "staffPayments": 34.0,
                        "list": [{
                            "id": "staff-payment-1",
                            "amount": 34.0,
                            "type": "salary_advance",
                            "notes": "Friday advance",
                            "createdAt": "2026-07-23T15:00:00Z"
                        }]
                    }
                }
            ]
        }));

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].staff_name, "Alex");
        assert_eq!(entries[0].role, "driver");
        assert_eq!(entries[0].reason, "Friday advance");
        assert_eq!(entries[0].amount, 34.0);
    }

    #[test]
    fn test_z_report_staff_payment_type_is_not_printed_as_a_note() {
        let entries = z_report_staff_payment_entries(&serde_json::json!({
            "staffReports": [{
                "staffName": "Gjergji Haxhi",
                "role": "driver",
                "payments": {
                    "list": [{
                        "id": "staff-payment-1",
                        "amount": 36.0,
                        "paymentType": "driver_wage"
                    }]
                }
            }]
        }));

        assert_eq!(entries.len(), 1);
        assert!(
            entries[0].reason.is_empty(),
            "payment type must not become an automatic staff-payment note"
        );
    }

    #[test]
    fn test_z_report_staff_payment_entries_support_legacy_aggregate_reports() {
        let entries = z_report_staff_payment_entries(&serde_json::json!({
            "staffReports": [
                {
                    "staffName": "Maria",
                    "role": "cashier",
                    "payments": {"staffPayments": 34.0}
                },
                {
                    "staffName": "Alex",
                    "role": "driver",
                    "payments": {"staffPayments": 34.0}
                }
            ]
        }));

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].staff_name, "Alex");
        assert_eq!(entries[0].role, "driver");
        assert_eq!(entries[0].amount, 34.0);
    }

    #[test]
    fn test_idempotency_allows_retry_after_failure() {
        let db = test_db();

        // Enqueue
        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-4",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        let job_id = result["jobId"].as_str().unwrap().to_string();

        // Fail it 3 times to exhaust retries
        for _ in 0..3 {
            mark_job_printing_for_test(&db, &job_id);
            mark_print_job_failed(&db, &job_id, "error").unwrap();
        }

        // Now the job is "failed" — a new enqueue for same entity should create a new job
        let result2 = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-4",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        assert_eq!(result2["success"], true);
        assert_eq!(result2.get("duplicate"), None);
        let new_job_id = result2["jobId"].as_str().unwrap();
        assert_ne!(new_job_id, job_id);
    }

    #[test]
    fn test_generate_receipt_file() {
        let db = test_db();

        // Insert an order so receipt generation works
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (10.0 → 1000).
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type, sync_status, created_at, updated_at)
                 VALUES ('ord-gen', 'ORD-999', '[{\"name\":\"Test Item\",\"quantity\":1,\"totalPrice\":10.0}]', 10.0, 1000, 10.0, 1000, 'completed', 'dine-in', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }

        let dir = std::env::temp_dir().join("pos_tauri_test_print");
        let _ = fs::create_dir_all(&dir);

        let path = generate_receipt_file(&db, "ord-gen", &dir).unwrap();
        assert!(path.contains("receipt_ord-gen_"));
        assert!(path.ends_with(".html"));

        // Verify file exists and contains expected content
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("ORD-999"));
        assert!(content.contains("Test Item"));
        assert!(content.contains("10.00"));

        // Cleanup
        let _ = fs::remove_dir_all(dir.join(RECEIPTS_DIR));
    }

    #[test]
    fn test_process_pending_jobs() {
        let db = test_db();

        // Insert an order
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (6.0 → 600).
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type, sync_status, created_at, updated_at)
                 VALUES ('ord-proc', 'ORD-100', '[{\"name\":\"Coffee\",\"quantity\":2,\"totalPrice\":6.0}]', 6.0, 600, 6.0, 600, 'completed', 'takeaway', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }

        // Enqueue a print job
        enqueue_print_job(
            &db,
            "order_receipt",
            "ord-proc",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();

        let dir = std::env::temp_dir().join("pos_tauri_test_worker");
        let _ = fs::create_dir_all(&dir);

        // Process
        let count = process_pending_jobs(&db, &dir).unwrap();
        assert_eq!(count, 1);

        // No hardware profile configured -> non-retryable failure.
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["status"], "failed");
        assert_eq!(arr[0]["retryCount"], 1);
        assert!(arr[0]["lastError"]
            .as_str()
            .unwrap_or_default()
            .contains("No hardware printer profile resolved"));
        assert!(arr[0]["nextRetryAt"].is_null());

        // Process again — should be no-op
        let count2 = process_pending_jobs(&db, &dir).unwrap();
        assert_eq!(count2, 0);

        // Cleanup
        let _ = fs::remove_dir_all(dir.join(RECEIPTS_DIR));
    }

    #[test]
    fn test_set_print_job_warning() {
        let db = test_db();

        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-warn",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        // Mark as dispatched first (warnings apply to successful jobs)
        mark_print_job_dispatched(&db, job_id, "/tmp/receipt.html").unwrap();

        // Set a warning
        set_print_job_warning(
            &db,
            job_id,
            "drawer_kick_failed",
            "TCP connect failed: timeout",
        )
        .unwrap();

        // Verify warning is visible in the job list
        let jobs = list_print_jobs(&db, Some("dispatched")).unwrap();
        let arr = jobs.as_array().unwrap();
        let job = arr.iter().find(|j| j["id"] == job_id).unwrap();
        assert_eq!(job["warningCode"], "drawer_kick_failed");
        assert_eq!(job["warningMessage"], "TCP connect failed: timeout");
        assert_eq!(job["status"], "dispatched"); // status unchanged
    }

    #[test]
    fn test_print_job_last_attempt_at_set() {
        let db = test_db();

        let result = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-ts",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        // Mark as dispatched
        mark_print_job_dispatched(&db, job_id, "/tmp/receipt.html").unwrap();

        // Verify last_attempt_at is set
        let jobs = list_print_jobs(&db, Some("dispatched")).unwrap();
        let arr = jobs.as_array().unwrap();
        let job = arr.iter().find(|j| j["id"] == job_id).unwrap();
        assert!(
            job["lastAttemptAt"].as_str().is_some(),
            "lastAttemptAt should be set after dispatch"
        );
    }

    #[test]
    fn test_process_job_for_missing_order() {
        let db = test_db();

        // Enqueue a job for a non-existent order
        enqueue_print_job(
            &db,
            "order_receipt",
            "ord-nonexistent",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();

        let dir = std::env::temp_dir().join("pos_tauri_test_missing");
        let _ = fs::create_dir_all(&dir);

        // Process — should fail the job gracefully
        let count = process_pending_jobs(&db, &dir).unwrap();
        assert_eq!(count, 1);

        // Job should have retry_count incremented
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr[0]["retryCount"], 1);
        assert!(arr[0]["lastError"].as_str().unwrap().contains("not found"));
    }

    #[test]
    fn test_enqueue_shift_checkout_job() {
        let db = test_db();
        let result = enqueue_print_job(
            &db,
            "shift_checkout",
            "shift-42",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        assert_eq!(result["success"], true);
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["entityType"], "shift_checkout");
    }

    #[test]
    fn test_recover_stale_printing_jobs() {
        let db = test_db();

        // Enqueue a job then manually set it to 'printing' with an old timestamp
        enqueue_print_job(
            &db,
            "order_receipt",
            "ord-stale",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs SET status = 'printing', updated_at = datetime('now', '-2 minutes')",
                [],
            )
            .unwrap();
        }

        // Verify it's stuck in 'printing'
        let jobs = list_print_jobs(&db, Some("printing")).unwrap();
        assert_eq!(jobs.as_array().unwrap().len(), 1);

        // Recovery should fail closed instead of auto-retrying unknown-state output.
        let recovered = recover_stale_printing_jobs(&db).unwrap();
        assert_eq!(recovered, 1);

        // Now it should be 'failed' and require an operator-triggered retry.
        let failed = list_print_jobs(&db, Some("failed")).unwrap();
        assert_eq!(failed.as_array().unwrap().len(), 1);
        let job = &failed.as_array().unwrap()[0];
        assert_eq!(job["warningCode"], "stale_printing_unknown");
        assert!(job["lastError"]
            .as_str()
            .unwrap_or_default()
            .contains("Automatic retry stopped"));
        let printing = list_print_jobs(&db, Some("printing")).unwrap();
        assert_eq!(printing.as_array().unwrap().len(), 0);
        let conn = db.conn.lock().unwrap();
        let job_id: String = conn
            .query_row(
                "SELECT id FROM print_jobs WHERE entity_id = 'ord-stale'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_terminal_parent_history(&conn, &job_id, "failed");
    }

    #[test]
    fn stale_recovery_preserves_active_unknown_windows_attempts_and_24_hour_history() {
        let db = test_db();
        let unknown_job = Uuid::new_v4().to_string();
        let windows_job = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            for job_id in [&unknown_job, &windows_job] {
                conn.execute(
                    "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
                     VALUES (?1, 'order_receipt', 'entity', 'printing', datetime('now','-2 days'), datetime('now','-2 minutes'))",
                    [job_id],
                ).unwrap();
            }
            conn.execute(
                "INSERT INTO print_jobs (
                     id, entity_type, entity_id, status, created_at, updated_at,
                     completed_at, history_expires_at
                 ) VALUES (
                     'retained-history', 'order_receipt', 'history', 'failed',
                     '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z',
                     '2026-06-02T00:00:00Z', '2026-07-02 00:00:00'
                 )",
                [],
            )
            .unwrap();
            let unknown = crate::print_dispatch::create_attempt(
                &conn,
                crate::print_dispatch::NewAttempt {
                    local_job_id: unknown_job.clone(),
                    target: PrinterTargetKey::RawTcp {
                        host: "unknown.local".into(),
                        port: 9100,
                    },
                    document_kind: "order_receipt".into(),
                    bytes_requested: 10,
                    now: Utc::now(),
                },
            )
            .unwrap();
            crate::print_dispatch::transition_attempt(
                &conn,
                unknown.attempt_id,
                DispatchState::Submitting,
                AttemptObservation::default(),
            )
            .unwrap();
            crate::print_dispatch::transition_attempt(
                &conn,
                unknown.attempt_id,
                DispatchState::Unknown,
                AttemptObservation {
                    last_error: Some("ambiguous".into()),
                    ..AttemptObservation::default()
                },
            )
            .unwrap();

            let windows = crate::print_dispatch::create_attempt(
                &conn,
                crate::print_dispatch::NewAttempt {
                    local_job_id: windows_job.clone(),
                    target: PrinterTargetKey::WindowsQueue("Recovery Queue".into()),
                    document_kind: "order_receipt".into(),
                    bytes_requested: 10,
                    now: Utc::now(),
                },
            )
            .unwrap();
            crate::print_dispatch::transition_attempt(
                &conn,
                windows.attempt_id,
                DispatchState::Submitting,
                AttemptObservation::default(),
            )
            .unwrap();
            let marker = crate::print_dispatch::read_attempt(&conn, windows.attempt_id)
                .unwrap()
                .unwrap()
                .document_name;
            crate::print_dispatch::persist_spool_started(
                &conn,
                windows.attempt_id,
                &crate::windows_spooler::SpoolStarted {
                    job_id: 42,
                    printer_name: "Recovery Queue".into(),
                    document_name: marker,
                    submitted_at: Utc::now(),
                },
            )
            .unwrap();
        }

        assert_eq!(recover_stale_printing_jobs(&db).unwrap(), 0);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE status = 'printing'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_jobs
                 WHERE id = 'retained-history'
                   AND completed_at = '2026-06-02T00:00:00Z'
                   AND history_expires_at = '2026-07-02 00:00:00'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn stale_recovery_uses_shared_all_attempt_blockers_and_respects_paused_profiles() {
        let db = test_db();
        let mut must_recover = Vec::new();
        let mut must_remain_printing = Vec::new();
        let paused_profile = "stale-recovery-paused-profile";
        let paused_job;
        {
            let conn = db.conn.lock().unwrap();
            for (index, state) in [
                "created",
                "submitting",
                "windows_queued",
                "windows_printing",
                "paused",
                "cancel_requested",
                "unknown",
                "cancel_failed",
            ]
            .into_iter()
            .enumerate()
            {
                let job_id = insert_control_job(&conn, "printing", None);
                let attempt_id = add_queued_windows_attempt(
                    &conn,
                    &job_id,
                    &format!("Named blocker {index}"),
                    10 + index as u32,
                );
                conn.execute(
                    "UPDATE print_job_attempts
                     SET state = ?1, spool_job_id = NULL
                     WHERE id = ?2",
                    params![state, attempt_id.to_string()],
                )
                .unwrap();
                must_remain_printing.push(job_id);
            }

            let valid_spool_error = insert_control_job(&conn, "printing", None);
            let valid_attempt =
                add_queued_windows_attempt(&conn, &valid_spool_error, "Valid spool error", 50);
            conn.execute(
                "UPDATE print_job_attempts SET state = 'spool_error' WHERE id = ?1",
                [valid_attempt.to_string()],
            )
            .unwrap();
            must_remain_printing.push(valid_spool_error);

            for (index, state) in ["sent", "spool_completed"].into_iter().enumerate() {
                let job_id = insert_control_job(&conn, "printing", None);
                let attempt_id = add_queued_windows_attempt(
                    &conn,
                    &job_id,
                    &format!("Terminal attempt {index}"),
                    60 + index as u32,
                );
                conn.execute(
                    "UPDATE print_job_attempts SET state = ?1 WHERE id = ?2",
                    params![state, attempt_id.to_string()],
                )
                .unwrap();
                must_recover.push(job_id);
            }

            for (index, invalid_value) in [
                "NULL",
                "0",
                "-1",
                "4294967296",
                "CAST(4.5 AS REAL)",
                "CAST('not-a-job-id' AS TEXT)",
                "X'0000002A'",
            ]
            .into_iter()
            .enumerate()
            {
                let job_id = insert_control_job(&conn, "printing", None);
                let attempt_id = add_queued_windows_attempt(
                    &conn,
                    &job_id,
                    &format!("Invalid spool error {index}"),
                    70 + index as u32,
                );
                conn.execute(
                    &format!(
                        "UPDATE print_job_attempts
                         SET state = 'spool_error', spool_job_id = {invalid_value}
                         WHERE id = ?1"
                    ),
                    [attempt_id.to_string()],
                )
                .unwrap();
                must_recover.push(job_id);
            }

            paused_job = insert_control_job(&conn, "printing", Some(paused_profile));
            db::set_setting(
                &conn,
                PRINT_QUEUE_SETTINGS_CATEGORY,
                &print_queue_pause_key(Some(paused_profile)),
                "true",
            )
            .unwrap();
        }

        assert_eq!(
            recover_stale_printing_jobs(&db).unwrap(),
            must_recover.len(),
            "only terminal attempts and spool_error rows without a valid SQLite INTEGER JobId recover"
        );

        let conn = db.conn.lock().unwrap();
        for job_id in must_recover {
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM print_jobs WHERE id = ?1",
                    [job_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
                "failed",
                "a non-blocking attempt must not stop stale parent recovery"
            );
        }
        for job_id in must_remain_printing
            .into_iter()
            .chain(std::iter::once(paused_job))
        {
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM print_jobs WHERE id = ?1",
                    [job_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
                "printing",
                "a shared blocker or paused profile must keep the stale parent untouched"
            );
        }
    }

    #[test]
    fn test_recent_printing_job_not_recovered() {
        let db = test_db();

        // Enqueue a job and set it to 'printing' with a recent timestamp (now)
        enqueue_print_job(
            &db,
            "order_receipt",
            "ord-recent",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs SET status = 'printing', updated_at = datetime('now')",
                [],
            )
            .unwrap();
        }

        // Recovery should NOT touch it — it's only been 'printing' for 0 seconds
        let recovered = recover_stale_printing_jobs(&db).unwrap();
        assert_eq!(recovered, 0);

        // Still in 'printing'
        let printing = list_print_jobs(&db, Some("printing")).unwrap();
        assert_eq!(printing.as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_stuck_printing_job_blocks_reenqueue_then_recovery_requires_new_job() {
        let db = test_db();

        // Enqueue and simulate a stuck 'printing' job
        enqueue_print_job(
            &db,
            "order_receipt",
            "ord-block",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs SET status = 'printing', updated_at = datetime('now', '-5 minutes')",
                [],
            )
            .unwrap();
        }

        // Trying to enqueue again returns duplicate
        let dup = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-block",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        assert_eq!(dup["duplicate"], true);

        // Recover the stale job
        recover_stale_printing_jobs(&db).unwrap();

        // After recovery it's failed, so an explicit new enqueue can create a
        // new job without automatically re-sending the unknown-state one.
        let replacement = enqueue_print_job(
            &db,
            "order_receipt",
            "ord-block",
            None,
            &NoopPrintQueueInvalidator,
        )
        .unwrap();
        assert_eq!(replacement["success"], true);
        assert!(replacement.get("duplicate").is_none());
        let pending = list_print_jobs(&db, Some("pending")).unwrap();
        assert_eq!(pending.as_array().unwrap().len(), 1);
        let failed = list_print_jobs(&db, Some("failed")).unwrap();
        assert_eq!(failed.as_array().unwrap().len(), 1);
    }

    // ---- #1: dispatch watchdog (bound the unbounded Windows spooler) ----

    #[test]
    fn test_run_dispatch_with_timeout_passes_through_fast_result() {
        // A dispatch that completes within the timeout returns its value verbatim.
        let out = run_dispatch_with_timeout(
            std::time::Duration::from_millis(500),
            Arc::new(AtomicBool::new(false)),
            || 42,
        );
        assert_eq!(out, Ok(42));
    }

    #[test]
    fn test_run_dispatch_with_timeout_fails_closed_on_hang() {
        // A dispatch slower than the timeout is abandoned and reported as an error,
        // so a hung printer cannot indefinitely occupy its managed target lane.
        let out = run_dispatch_with_timeout(
            std::time::Duration::from_millis(50),
            Arc::new(AtomicBool::new(false)),
            || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                99
            },
        );
        let err = out.expect_err("a dispatch slower than the timeout must fail");
        assert!(
            err.contains("did not respond within the dispatch timeout"),
            "unexpected error: {err}"
        );
        // Fail-closed is enforced structurally, not by this wording: the timeout arm of
        // `dispatch_managed_windows_attempt` finalizes with
        // `ParentTransition::ManualFailure`. That contract is pinned by
        // `manual_failure_is_terminal_and_never_schedules_an_auto_retry` in print_dispatch.
    }

    #[test]
    fn dispatch_timeout_requests_cooperative_transport_stop() {
        let cancel = Arc::new(AtomicBool::new(false));
        let out = run_dispatch_with_timeout(
            std::time::Duration::from_millis(20),
            Arc::clone(&cancel),
            || {
                std::thread::sleep(std::time::Duration::from_millis(200));
                99
            },
        );

        assert!(out.is_err());
        assert!(cancel.load(Ordering::Acquire));
    }

    // ---- #2: paused-profile exclusion happens in SQL, before LIMIT ----

    #[test]
    fn test_select_ready_pending_excludes_paused_before_limit() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // 10 OLDER pending jobs on a printer profile that is paused...
        for i in 0..10 {
            conn.execute(
                "INSERT INTO print_jobs (id, entity_type, entity_id, printer_profile_id, status, created_at, updated_at)
                 VALUES (?1, 'order_receipt', ?2, 'paused-printer', 'pending', datetime('now','-10 minutes'), datetime('now','-10 minutes'))",
                params![format!("job-p-{i}"), format!("ent-p-{i}")],
            )
            .unwrap();
        }
        // ...and ONE newer pending job on a healthy (NULL) profile.
        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, printer_profile_id, status, created_at, updated_at)
             VALUES ('job-healthy', 'order_receipt', 'ent-healthy', NULL, 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        let now = Utc::now().to_rfc3339();
        let mut paused = std::collections::HashSet::new();
        paused.insert("paused-printer".to_string());

        let jobs = select_ready_pending_jobs(&conn, &now, &paused, 10).unwrap();

        // The healthy job must be selected even though 10 OLDER paused jobs exist:
        // the LIMIT-10 window must not be starved by a paused printer's backlog.
        assert!(
            jobs.iter().any(|(id, ..)| id == "job-healthy"),
            "healthy NULL-profile job was starved by the paused printer's backlog"
        );
        // And no paused-profile job may be returned.
        assert!(
            jobs.iter()
                .all(|(.., profile)| profile.as_deref() != Some("paused-printer")),
            "paused profile jobs must be excluded in SQL"
        );
    }

    // ---- #3: DB mutex poison is recovered on the print path (not a permanent brick) ----

    #[test]
    fn test_recover_stale_printing_survives_poisoned_conn() {
        let db = test_db();
        // Poison the connection mutex: panic while holding the guard.
        std::thread::scope(|scope| {
            let handle = scope.spawn(|| {
                let _guard = db.conn.lock().unwrap();
                panic!("intentional panic to poison the print DB mutex");
            });
            let _ = handle.join(); // absorb the panic; the mutex is now poisoned
        });
        assert!(
            db.conn.lock().is_err(),
            "precondition: the conn mutex must be poisoned"
        );

        // The print path must recover the poisoned guard (a prior panic does not
        // corrupt the SQLite connection) instead of permanently bricking the queue.
        let result = recover_stale_printing_jobs(&db);
        assert!(
            result.is_ok(),
            "recovery must survive a poisoned conn mutex, got {result:?}"
        );
    }

    #[test]
    fn test_is_print_action_enabled_defaults() {
        let db = test_db();
        for key in &[
            "after_order",
            "after_edit",
            "payment_receipt",
            "split_receipt",
            "shift_close",
            "driver_assigned",
            "z_report",
            "kitchen_ticket",
        ] {
            assert!(
                is_print_action_enabled(&db, key),
                "key {key} should default true"
            );
        }
        assert!(!is_print_action_enabled(&db, "on_complete"));
        assert!(!is_print_action_enabled(&db, "on_cancel"));
    }

    #[test]
    fn test_after_edit_reprint_enqueues_by_order_type() {
        let db = test_db();
        let invalidator = RecordingQueueInvalidator::new(&db);
        enqueue_after_edit_auto_print(&db, "ord-edit-1", "pickup", false, &invalidator);
        enqueue_after_edit_auto_print(&db, "ord-edit-2", "delivery", false, &invalidator);
        let conn = db.conn.lock().unwrap();
        let receipt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs
                 WHERE entity_id = 'ord-edit-1' AND entity_type = 'order_receipt' AND status = 'pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let slip: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs
                 WHERE entity_id = 'ord-edit-2' AND entity_type = 'delivery_slip' AND status = 'pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            receipt, 1,
            "pickup edit must enqueue an order_receipt reprint"
        );
        assert_eq!(
            slip, 1,
            "delivery edit must enqueue a delivery_slip reprint"
        );
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 2);
    }

    #[test]
    fn test_after_edit_reprint_respects_disable_and_ghost() {
        let db = test_db();
        let invalidator = RecordingQueueInvalidator::new(&db);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES (?1, ?2, ?3)",
                rusqlite::params!["receipt_actions", "after_edit", "false"],
            )
            .unwrap();
        }
        enqueue_after_edit_auto_print(&db, "ord-edit-3", "pickup", false, &invalidator);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES (?1, ?2, ?3)",
                rusqlite::params!["receipt_actions", "after_edit", "true"],
            )
            .unwrap();
        }
        enqueue_after_edit_auto_print(&db, "ord-edit-4", "pickup", true, &invalidator); // ghost order
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE entity_id IN ('ord-edit-3','ord-edit-4')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 0,
            "disabled action and ghost orders must not enqueue reprints"
        );
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 0);
    }

    #[test]
    fn test_after_edit_reprint_keeps_single_pending_job() {
        let db = test_db();
        let invalidator = RecordingQueueInvalidator::new(&db);
        enqueue_after_edit_auto_print(&db, "ord-edit-5", "pickup", false, &invalidator);
        enqueue_after_edit_auto_print(&db, "ord-edit-5", "pickup", false, &invalidator);
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs
                 WHERE entity_id = 'ord-edit-5' AND entity_type = 'order_receipt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // The still-pending job renders at dispatch time, so it already
        // prints the edited state — one job is exactly right.
        assert_eq!(count, 1, "duplicate pending reprint must be coalesced");
        assert_eq!(invalidator.calls.load(Ordering::Acquire), 1);
    }

    #[test]
    fn test_is_print_action_enabled_explicit_false() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES (?1, ?2, ?3)",
            rusqlite::params!["receipt_actions", "after_order", "false"],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES (?1, ?2, ?3)",
            rusqlite::params!["receipt_actions", "on_complete", "true"],
        )
        .unwrap();
        drop(conn);
        assert!(!is_print_action_enabled(&db, "after_order"));
        assert!(is_print_action_enabled(&db, "on_complete"));
    }

    #[test]
    fn test_new_entity_types_accepted() {
        let db = test_db();
        let r1 = enqueue_print_job(
            &db,
            "order_completed_receipt",
            "ord-c1",
            None,
            &NoopPrintQueueInvalidator,
        );
        assert!(r1.is_ok(), "order_completed_receipt should be accepted");
        let r2 = enqueue_print_job(
            &db,
            "order_canceled_receipt",
            "ord-x1",
            None,
            &NoopPrintQueueInvalidator,
        );
        assert!(r2.is_ok(), "order_canceled_receipt should be accepted");
    }

    #[test]
    fn test_new_entity_types_use_receipt_layout() {
        assert!(
            is_receipt_like_entity_type("order_completed_receipt"),
            "order_completed_receipt must be receipt-like for proper LayoutConfig"
        );
        assert!(
            is_receipt_like_entity_type("order_canceled_receipt"),
            "order_canceled_receipt must be receipt-like for proper LayoutConfig"
        );
    }

    #[test]
    fn test_completed_receipt_sets_status_label() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (10.0 → 1000).
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type, sync_status, created_at, updated_at)
                 VALUES ('ord-done', 'ORD-DONE', '[]', 10.0, 1000, 10.0, 1000, 'completed', 'dine-in', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }
        let doc = match build_document_for_job(&db, "order_completed_receipt", "ord-done", None)
            .unwrap()
        {
            ReceiptDocument::OrderReceipt(d) => d,
            _ => panic!("expected OrderReceipt"),
        };
        assert!(
            doc.status_label
                .as_deref()
                .unwrap_or("")
                .contains("COMPLETED"),
            "status_label should contain COMPLETED"
        );
    }

    #[test]
    fn test_canceled_receipt_includes_reason() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (5.0 → 500).
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type, sync_status, created_at, updated_at)
                 VALUES ('ord-x', 'ORD-X', '[]', 5.0, 500, 5.0, 500, 'canceled', 'takeaway', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }
        let payload = serde_json::json!({ "cancellationReason": "Out of stock" }).to_string();
        let doc =
            match build_document_for_job(&db, "order_canceled_receipt", "ord-x", Some(&payload))
                .unwrap()
            {
                ReceiptDocument::OrderReceipt(d) => d,
                _ => panic!("expected OrderReceipt"),
            };
        assert_eq!(
            doc.cancellation_reason.as_deref(),
            Some("Out of stock"),
            "cancellation_reason should be 'Out of stock'"
        );
    }

    #[test]
    fn test_canceled_receipt_null_reason() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (5.0 → 500).
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, status, order_type, sync_status, created_at, updated_at)
                 VALUES ('ord-x2', 'ORD-X2', '[]', 5.0, 500, 5.0, 500, 'canceled', 'takeaway', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }
        let payload = serde_json::json!({ "cancellationReason": null }).to_string();
        let doc =
            match build_document_for_job(&db, "order_canceled_receipt", "ord-x2", Some(&payload))
                .unwrap()
            {
                ReceiptDocument::OrderReceipt(d) => d,
                _ => panic!("expected OrderReceipt"),
            };
        assert!(
            doc.cancellation_reason.is_none(),
            "cancellation_reason should be None when payload has null"
        );
    }
}
