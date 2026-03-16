//! PIN-based local authentication with bcrypt.
//!
//! Provides admin and staff login, session management, lockout tracking,
//! and permission checking. PIN hashes are stored in the SQLite
//! `local_settings` table (category "staff", keys "admin_pin_hash" /
//! "staff_pin_hash"). Sessions are kept in-memory; the `staff_sessions`
//! table is used only for audit/persistence across restarts.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tracing::{info, warn};
use uuid::Uuid;

use crate::{db, storage};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FAILED_ATTEMPTS: u32 = 5;
const LOCKOUT_MINUTES: i64 = 15;
const SESSION_INACTIVITY_MINUTES: i64 = 30;
const SESSION_MAX_DURATION_HOURS: i64 = 2;
pub(crate) const PRIVILEGED_ACTION_TTL_SECONDS: i64 = 300;
const LOCKOUT_ATTEMPTS_KEY: &str = "lockout_attempts";
const LOCKOUT_LAST_ATTEMPT_KEY: &str = "lockout_last_attempt";
const STAFF_AUTH_CACHE_CATEGORY: &str = "staff_auth_cache";

/// Permissions granted to administrators.
const ADMIN_PERMISSIONS: &[&str] = &[
    "view_orders",
    "update_order_status",
    "create_order",
    "delete_order",
    "view_reports",
    "manage_staff",
    "system_settings",
    "force_sync",
];

/// Permissions granted to regular staff.
const STAFF_PERMISSIONS: &[&str] = &["view_orders", "update_order_status", "create_order"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// An active staff session.
#[derive(Clone, Debug)]
struct StaffSession {
    session_id: String,
    staff_id: String,
    role: String,
    permissions: Vec<String>,
    login_time: DateTime<Utc>,
    last_activity: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

impl StaffSession {
    /// Check whether this session has expired (inactivity or max duration).
    fn is_expired(&self) -> bool {
        let now = Utc::now();
        if now >= self.expires_at {
            return true;
        }
        if now - self.last_activity > Duration::minutes(SESSION_INACTIVITY_MINUTES) {
            return true;
        }
        false
    }

    /// Convert to the JSON shape the React frontend expects.
    fn to_user_json(&self) -> Value {
        let branch_id =
            storage::get_credential("branch_id").unwrap_or_else(|| "default-branch".into());
        let terminal_id =
            storage::get_credential("terminal_id").unwrap_or_else(|| "default-terminal".into());

        serde_json::json!({
            "staffId": self.staff_id,
            "staffName": if self.role == "admin" { "Administrator" } else { "Staff" },
            "role": {
                "name": self.role,
                "permissions": self.permissions,
            },
            "branchId": branch_id,
            "terminalId": terminal_id,
            "sessionId": self.session_id,
        })
    }
}

/// Lockout tracking entry.
struct LockoutEntry {
    attempts: u32,
    last_attempt: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
struct StaffCheckInVerifyRequest {
    #[serde(alias = "staffId")]
    staff_id: String,
    #[serde(alias = "branchId")]
    branch_id: String,
    pin: String,
}

#[derive(Debug, Clone, Deserialize)]
struct StaffAuthDirectoryCache {
    #[serde(default, alias = "branchId")]
    branch_id: String,
    #[serde(default)]
    staff: Vec<StaffAuthCacheEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct StaffAuthCacheEntry {
    id: String,
    #[serde(default)]
    can_login_pos: Option<bool>,
    #[serde(default)]
    has_pin: Option<bool>,
    #[serde(default)]
    pin_hash: Option<String>,
    #[serde(default)]
    is_active: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PrivilegedActionScope {
    SystemControl,
    CashDrawerControl,
}

impl PrivilegedActionScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SystemControl => "system_control",
            Self::CashDrawerControl => "cash_drawer_control",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "system_control" => Some(Self::SystemControl),
            "cash_drawer_control" => Some(Self::CashDrawerControl),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, thiserror::Error, PartialEq, Eq)]
#[error("{code}: {reason}")]
pub struct PrivilegedActionError {
    pub code: &'static str,
    pub scope: String,
    pub reason: String,
    #[serde(rename = "ttlSeconds", skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<i64>,
}

impl PrivilegedActionError {
    fn unauthorized(scope: Option<PrivilegedActionScope>, reason: impl Into<String>) -> Self {
        Self {
            code: "UNAUTHORIZED",
            scope: scope
                .map(PrivilegedActionScope::as_str)
                .unwrap_or("unknown")
                .to_string(),
            reason: reason.into(),
            ttl_seconds: None,
        }
    }

    fn reauth_required(scope: PrivilegedActionScope, reason: impl Into<String>) -> Self {
        Self {
            code: "REAUTH_REQUIRED",
            scope: scope.as_str().to_string(),
            reason: reason.into(),
            ttl_seconds: Some(PRIVILEGED_ACTION_TTL_SECONDS),
        }
    }
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(untagged)]
pub enum GuardedCommandError {
    #[error(transparent)]
    Structured(#[from] PrivilegedActionError),
    #[error("{0}")]
    Message(String),
}

impl From<&str> for GuardedCommandError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_string())
    }
}

impl From<String> for GuardedCommandError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

/// Tauri managed state for authentication.
pub struct AuthState {
    sessions: Mutex<HashMap<String, StaffSession>>,
    current_session_id: Mutex<Option<String>>,
    lockout: Mutex<LockoutEntry>,
    privileged_grants: Mutex<HashMap<String, DateTime<Utc>>>,
}

impl AuthState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            current_session_id: Mutex::new(None),
            lockout: Mutex::new(LockoutEntry {
                attempts: 0,
                last_attempt: Utc::now(),
            }),
            privileged_grants: Mutex::new(HashMap::new()),
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract the PIN string from the arg0 value, which may be:
/// - A plain string: `"1234"`
/// - A JSON object: `{"pin":"1234"}`
fn extract_pin(arg: &Value) -> Option<String> {
    if let Some(s) = arg.as_str() {
        return Some(s.to_string());
    }
    if let Some(obj) = arg.as_object() {
        if let Some(p) = obj.get("pin").and_then(Value::as_str) {
            return Some(p.to_string());
        }
    }
    None
}

fn extract_scope(arg: &Value) -> Option<PrivilegedActionScope> {
    if let Some(scope) = arg.as_str() {
        return PrivilegedActionScope::parse(scope);
    }
    if let Some(obj) = arg.as_object() {
        if let Some(scope) = obj.get("scope").and_then(Value::as_str) {
            return PrivilegedActionScope::parse(scope);
        }
    }
    None
}

fn staff_auth_cache_key(branch_id: &str) -> String {
    format!("branch_{}", branch_id.trim())
}

fn load_staff_auth_cache(
    db: &db::DbState,
    branch_id: &str,
) -> Result<StaffAuthDirectoryCache, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let Some(raw) = db::get_setting(
        &conn,
        STAFF_AUTH_CACHE_CATEGORY,
        &staff_auth_cache_key(branch_id),
    ) else {
        return Err("missing staff auth cache".to_string());
    };

    serde_json::from_str(&raw).map_err(|e| format!("invalid staff auth cache: {e}"))
}

fn check_in_verify_failure(code: &str, error: &str) -> Value {
    serde_json::json!({
        "success": false,
        "reasonCode": code,
        "error": error,
    })
}

fn grant_key(session_id: &str, scope: PrivilegedActionScope) -> String {
    format!("{session_id}:{}", scope.as_str())
}

fn prune_expired_privileged_grants(auth: &AuthState, now: DateTime<Utc>) {
    if let Ok(mut grants) = auth.privileged_grants.lock() {
        grants.retain(|_, expires_at| *expires_at > now);
    }
}

fn clear_privileged_grants_for_session(auth: &AuthState, session_id: &str) {
    if let Ok(mut grants) = auth.privileged_grants.lock() {
        let prefix = format!("{session_id}:");
        grants.retain(|key, _| !key.starts_with(&prefix));
    }
}

fn record_privileged_grant_at(
    auth: &AuthState,
    session_id: &str,
    scope: PrivilegedActionScope,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    let expires_at = now + Duration::seconds(PRIVILEGED_ACTION_TTL_SECONDS);
    let mut grants = auth
        .privileged_grants
        .lock()
        .map_err(|e| format!("privileged grants mutex poisoned: {e}"))?;
    grants.insert(grant_key(session_id, scope), expires_at);
    Ok(expires_at)
}

fn has_fresh_privileged_grant_at(
    auth: &AuthState,
    session_id: &str,
    scope: PrivilegedActionScope,
    now: DateTime<Utc>,
) -> bool {
    prune_expired_privileged_grants(auth, now);
    auth.privileged_grants
        .lock()
        .ok()
        .and_then(|grants| grants.get(&grant_key(session_id, scope)).cloned())
        .map(|expires_at| expires_at > now)
        .unwrap_or(false)
}

fn resolve_current_terminal_id(db: &db::DbState) -> Result<String, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    if let Some(terminal_id) = db::get_setting(&conn, "terminal", "terminal_id")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Ok(terminal_id);
    }
    drop(conn);

    storage::get_credential("terminal_id")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("Current terminal is not configured in local storage".to_string())
}

fn current_terminal_has_cash_drawer_role(db: &db::DbState) -> Result<bool, String> {
    let terminal_id = resolve_current_terminal_id(db)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let role: Option<String> = conn
        .query_row(
            "SELECT role_type
             FROM staff_shifts
             WHERE terminal_id = ?1 AND status = 'active'
             ORDER BY check_in_time DESC
             LIMIT 1",
            rusqlite::params![terminal_id],
            |row| row.get(0),
        )
        .ok();

    Ok(matches!(role.as_deref(), Some("cashier" | "manager")))
}

fn verify_pin_for_session(
    pin: &str,
    session: &StaffSession,
    db: &db::DbState,
) -> Result<bool, String> {
    let key = if session.role == "admin" {
        "admin_pin_hash"
    } else {
        "staff_pin_hash"
    };
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let Some(hash) = db::get_setting(&conn, "staff", key) else {
        return Ok(false);
    };
    bcrypt::verify(pin, &hash).map_err(|e| format!("Failed to verify PIN: {e}"))
}

/// Check whether the terminal is currently locked out.
fn check_lockout(lockout: &LockoutEntry) -> Result<(), String> {
    if lockout.attempts >= MAX_FAILED_ATTEMPTS {
        let elapsed = Utc::now() - lockout.last_attempt;
        if elapsed < Duration::minutes(LOCKOUT_MINUTES) {
            let remaining = LOCKOUT_MINUTES - elapsed.num_minutes();
            return Err(format!(
                "Too many failed attempts. Try again in {remaining} minute(s)."
            ));
        }
        // Lockout period has elapsed — will be reset on next successful login
    }
    Ok(())
}

/// Record a failed login attempt.
fn record_failure(lockout: &mut LockoutEntry) {
    lockout.attempts += 1;
    lockout.last_attempt = Utc::now();
    warn!(attempts = lockout.attempts, "failed login attempt");
}

/// Reset the lockout counter (on successful login).
fn reset_lockout(lockout: &mut LockoutEntry) {
    lockout.attempts = 0;
    lockout.last_attempt = Utc::now();
}

/// Load persisted lockout state from local_settings.
fn load_lockout_from_db(conn: &rusqlite::Connection) -> LockoutEntry {
    let attempts = db::get_setting(conn, "staff", LOCKOUT_ATTEMPTS_KEY)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    let last_attempt = db::get_setting(conn, "staff", LOCKOUT_LAST_ATTEMPT_KEY)
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(&v).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    LockoutEntry {
        attempts,
        last_attempt,
    }
}

/// Persist lockout state in local_settings.
fn persist_lockout_to_db(conn: &rusqlite::Connection, lockout: &LockoutEntry) {
    let _ = db::set_setting(
        conn,
        "staff",
        LOCKOUT_ATTEMPTS_KEY,
        &lockout.attempts.to_string(),
    );
    let _ = db::set_setting(
        conn,
        "staff",
        LOCKOUT_LAST_ATTEMPT_KEY,
        &lockout.last_attempt.to_rfc3339(),
    );
}

/// Create a new session and register it in the auth state.
fn create_session(auth: &AuthState, role: &str, staff_id: &str) -> Value {
    let now = Utc::now();
    let permissions: Vec<String> = if role == "admin" {
        ADMIN_PERMISSIONS.iter().map(|s| s.to_string()).collect()
    } else {
        STAFF_PERMISSIONS.iter().map(|s| s.to_string()).collect()
    };

    let session = StaffSession {
        session_id: Uuid::new_v4().to_string(),
        staff_id: staff_id.to_string(),
        role: role.to_string(),
        permissions,
        login_time: now,
        last_activity: now,
        expires_at: now + Duration::hours(SESSION_MAX_DURATION_HOURS),
    };

    let user_json = session.to_user_json();
    let sid = session.session_id.clone();

    if let Ok(mut sessions) = auth.sessions.lock() {
        sessions.insert(sid.clone(), session);
    }
    if let Ok(mut current) = auth.current_session_id.lock() {
        *current = Some(sid);
    }

    serde_json::json!({
        "success": true,
        "user": user_json,
    })
}

/// Get the current active session (if it exists and is not expired).
fn get_current_session(auth: &AuthState) -> Option<StaffSession> {
    let current_id = auth.current_session_id.lock().ok()?.clone()?;
    let sessions = auth.sessions.lock().ok()?;
    let session = sessions.get(&current_id)?.clone();
    if session.is_expired() {
        return None;
    }
    Some(session)
}

// ---------------------------------------------------------------------------
// Public command implementations
// ---------------------------------------------------------------------------

/// Handle auth:login — verify PIN against stored hashes, create a session.
pub fn login(arg0: Option<Value>, db: &db::DbState, auth: &AuthState) -> Result<Value, String> {
    // Extract PIN
    let pin_val = arg0.ok_or("Missing login argument")?;
    let pin = extract_pin(&pin_val).ok_or("Invalid login payload: expected a PIN string")?;

    if pin.is_empty() {
        return Err("PIN is required".into());
    }

    // Read PIN hashes and synchronize lockout state from durable storage.
    // The entire lockout load→check→verify→record→persist flow is wrapped in
    // a single DB transaction + mutex critical section to prevent TOCTOU races
    // if two login attempts arrive simultaneously.
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // BEGIN IMMEDIATE to acquire a write lock up front
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin auth transaction: {e}"))?;

    let persisted_lockout = load_lockout_from_db(&conn);
    let mut lockout = auth
        .lockout
        .lock()
        .map_err(|e| format!("mutex poisoned: {e}"))?;
    *lockout = persisted_lockout;
    if let Err(e) = check_lockout(&lockout) {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e);
    }

    let admin_hash = db::get_setting(&conn, "staff", "admin_pin_hash");
    let staff_hash = db::get_setting(&conn, "staff", "staff_pin_hash");

    // Dummy hash used when no PIN is configured, so bcrypt::verify still runs
    // and the total timing remains constant regardless of which hashes exist.
    const DUMMY_HASH: &str = "$2b$12$000000000000000000000uKYMKnMSMFxOuTQFqzfB/F6JcvrFvlq";

    // Always verify against BOTH hashes to prevent timing side-channels.
    // An attacker must not be able to distinguish admin/staff/no-PIN by
    // measuring response time (each path runs exactly 2 bcrypt verifications).
    let admin_ok =
        bcrypt::verify(&pin, admin_hash.as_deref().unwrap_or(DUMMY_HASH)).unwrap_or(false);
    let staff_ok =
        bcrypt::verify(&pin, staff_hash.as_deref().unwrap_or(DUMMY_HASH)).unwrap_or(false);

    let result = if admin_ok && admin_hash.is_some() {
        reset_lockout(&mut lockout);
        persist_lockout_to_db(&conn, &lockout);
        info!("admin login successful");
        Ok(("admin", "admin-user"))
    } else if staff_ok && staff_hash.is_some() {
        reset_lockout(&mut lockout);
        persist_lockout_to_db(&conn, &lockout);
        info!("staff login successful");
        Ok(("staff", "staff-user"))
    } else {
        record_failure(&mut lockout);
        persist_lockout_to_db(&conn, &lockout);
        Err("Invalid PIN".to_string())
    };

    conn.execute_batch("COMMIT")
        .map_err(|e| format!("commit auth transaction: {e}"))?;
    // Release the lockout mutex before creating the session
    drop(lockout);

    match result {
        Ok((role, user_id)) => Ok(create_session(auth, role, user_id)),
        Err(e) => Err(e),
    }
}

/// Verify a selected staff member's POS PIN against the cached branch-scoped
/// auth directory. This is used for shift check-in and must not mutate the
/// global app-login auth session.
pub fn verify_staff_check_in_pin(arg0: Option<Value>, db: &db::DbState) -> Result<Value, String> {
    let payload = arg0.ok_or("Missing staff check-in payload")?;
    let request: StaffCheckInVerifyRequest = serde_json::from_value(payload)
        .map_err(|_| "Invalid staff check-in payload".to_string())?;

    let staff_id = request.staff_id.trim();
    let branch_id = request.branch_id.trim();
    let pin = request.pin.trim();

    if staff_id.is_empty() || branch_id.is_empty() || pin.is_empty() {
        return Ok(check_in_verify_failure(
            "staff_auth_unavailable",
            "Staff auth data unavailable offline. Please sync staff while online.",
        ));
    }

    let cache = match load_staff_auth_cache(db, branch_id) {
        Ok(cache) => cache,
        Err(_) => {
            return Ok(check_in_verify_failure(
                "staff_auth_unavailable",
                "Staff auth data unavailable offline. Please sync staff while online.",
            ))
        }
    };

    if !cache.branch_id.trim().is_empty() && cache.branch_id.trim() != branch_id {
        return Ok(check_in_verify_failure(
            "staff_auth_unavailable",
            "Staff auth data unavailable offline. Please sync staff while online.",
        ));
    }

    let maybe_staff = cache
        .staff
        .iter()
        .find(|entry| entry.id.trim().eq_ignore_ascii_case(staff_id));

    let Some(staff) = maybe_staff else {
        return Ok(check_in_verify_failure(
            "staff_not_available_offline",
            "Selected staff member is not available in the local POS staff cache.",
        ));
    };

    if staff.is_active == Some(false) || staff.can_login_pos == Some(false) {
        return Ok(check_in_verify_failure(
            "pos_login_disabled",
            "This staff member is not allowed to log in on POS.",
        ));
    }

    if staff.has_pin == Some(false) {
        return Ok(check_in_verify_failure(
            "pin_not_configured",
            "No POS PIN is configured for this staff member.",
        ));
    }

    let Some(hash) = staff
        .pin_hash
        .as_deref()
        .map(str::trim)
        .filter(|hash| !hash.is_empty())
    else {
        return Ok(check_in_verify_failure(
            "pin_not_configured",
            "No POS PIN is configured for this staff member.",
        ));
    };

    let pin_ok =
        bcrypt::verify(pin, hash).map_err(|e| format!("Failed to verify staff PIN: {e}"))?;
    if !pin_ok {
        return Ok(check_in_verify_failure("invalid_pin", "Invalid PIN"));
    }

    Ok(serde_json::json!({
        "success": true,
        "staffId": staff_id,
        "branchId": branch_id,
    }))
}

/// Handle auth:logout — invalidate the current session.
pub fn logout(auth: &AuthState) {
    let Ok(mut current) = auth.current_session_id.lock() else {
        tracing::warn!("logout: current_session_id mutex poisoned");
        return;
    };
    if let Some(sid) = current.take() {
        let Ok(mut sessions) = auth.sessions.lock() else {
            tracing::warn!("logout: sessions mutex poisoned");
            return;
        };
        sessions.remove(&sid);
        drop(sessions);
        clear_privileged_grants_for_session(auth, &sid);
        info!(session_id = %sid, "session logged out");
    }
}

/// Handle auth:get-current-session — return the current session or null.
pub fn get_session_json(auth: &AuthState) -> Value {
    match get_current_session(auth) {
        Some(s) => s.to_user_json(),
        None => Value::Null,
    }
}

/// Handle auth:validate-session.
pub fn validate_session(auth: &AuthState) -> Value {
    match get_current_session(auth) {
        Some(_) => serde_json::json!({ "valid": true }),
        None => {
            // Clean up expired session
            if let Ok(mut current) = auth.current_session_id.lock() {
                if let Some(sid) = current.take() {
                    if let Ok(mut sessions) = auth.sessions.lock() {
                        sessions.remove(&sid);
                    }
                    clear_privileged_grants_for_session(auth, &sid);
                }
            }
            serde_json::json!({ "valid": false, "reason": "Session expired or not found" })
        }
    }
}

/// Handle auth:has-permission.
pub fn has_permission(auth: &AuthState, permission: Option<&str>) -> bool {
    let perm = match permission {
        Some(p) => p,
        None => return false,
    };
    match get_current_session(auth) {
        Some(s) => s.permissions.iter().any(|p| p == perm),
        None => false,
    }
}

/// Handle staff-auth:has-any-permission.
pub fn has_any_permission(auth: &AuthState, permissions: Option<&[String]>) -> bool {
    let perms = match permissions {
        Some(p) => p,
        None => return false,
    };
    match get_current_session(auth) {
        Some(s) => perms.iter().any(|p| s.permissions.contains(p)),
        None => false,
    }
}

/// Handle auth:get-session-stats.
pub fn get_session_stats(auth: &AuthState) -> Value {
    match get_current_session(auth) {
        Some(s) => serde_json::json!({
            "sessionId": s.session_id,
            "role": s.role,
            "loginTime": s.login_time.to_rfc3339(),
            "lastActivity": s.last_activity.to_rfc3339(),
            "expiresAt": s.expires_at.to_rfc3339(),
        }),
        None => serde_json::json!({}),
    }
}

/// Handle auth:setup-pin — validate, hash, and store admin/staff PINs.
pub fn setup_pin(arg0: Option<Value>, db: &db::DbState) -> Result<Value, String> {
    let payload = arg0.ok_or("Missing PIN setup payload")?;

    let admin_pin = payload.get("adminPin").and_then(Value::as_str);
    let staff_pin = payload.get("staffPin").and_then(Value::as_str);

    if admin_pin.is_none() && staff_pin.is_none() {
        return Err("At least one PIN (adminPin or staffPin) is required".into());
    }

    // Validate: numeric, 4–32 digits
    fn validate_pin(pin: &str, label: &str) -> Result<(), String> {
        if pin.len() < 4 {
            return Err(format!("{label} must be at least 4 digits"));
        }
        if pin.len() > 32 {
            return Err(format!("{label} must be 32 characters or fewer"));
        }
        if !pin.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("{label} must contain only digits"));
        }
        Ok(())
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    if let Some(pin) = admin_pin {
        validate_pin(pin, "Admin PIN")?;
        let hash = bcrypt::hash(pin, bcrypt::DEFAULT_COST)
            .map_err(|e| format!("Failed to hash admin PIN: {e}"))?;
        db::set_setting(&conn, "staff", "admin_pin_hash", &hash)?;
        info!("admin PIN set");
    }

    if let Some(pin) = staff_pin {
        validate_pin(pin, "Staff PIN")?;
        let hash = bcrypt::hash(pin, bcrypt::DEFAULT_COST)
            .map_err(|e| format!("Failed to hash staff PIN: {e}"))?;
        db::set_setting(&conn, "staff", "staff_pin_hash", &hash)?;
        info!("staff PIN set");
    }

    db::set_setting(&conn, "terminal", "pin_reset_required", "false")?;

    Ok(serde_json::json!({ "success": true }))
}

/// Handle staff-auth:track-activity — refresh the inactivity timer.
pub fn track_activity(auth: &AuthState) {
    let current_id = auth.current_session_id.lock().ok().and_then(|g| g.clone());
    if let Some(sid) = current_id {
        let Ok(mut sessions) = auth.sessions.lock() else {
            return;
        };
        if let Some(session) = sessions.get_mut(&sid) {
            session.last_activity = Utc::now();
        }
    }
}

/// Handle staff-auth:get-current — return current user info or null.
pub fn get_current_user(auth: &AuthState) -> Value {
    get_session_json(auth)
}

fn authorize_privileged_action_at(
    scope: PrivilegedActionScope,
    db: &db::DbState,
    auth: &AuthState,
    now: DateTime<Utc>,
) -> Result<StaffSession, PrivilegedActionError> {
    let Some(session) = get_current_session(auth) else {
        return Err(PrivilegedActionError::unauthorized(
            Some(scope),
            "Active session required",
        ));
    };

    if scope == PrivilegedActionScope::SystemControl && session.role != "admin" {
        return Err(PrivilegedActionError::unauthorized(
            Some(scope),
            "Active admin session required",
        ));
    }

    if scope == PrivilegedActionScope::CashDrawerControl {
        match current_terminal_has_cash_drawer_role(db) {
            Ok(true) => {}
            Ok(false) => {
                return Err(PrivilegedActionError::unauthorized(
                    Some(scope),
                    "Active cashier or manager shift required on this terminal",
                ));
            }
            Err(error) => {
                return Err(PrivilegedActionError::unauthorized(Some(scope), error));
            }
        }
    }

    if !has_fresh_privileged_grant_at(auth, &session.session_id, scope, now) {
        return Err(PrivilegedActionError::reauth_required(
            scope,
            "Fresh PIN confirmation required",
        ));
    }

    Ok(session)
}

pub fn authorize_privileged_action(
    scope: PrivilegedActionScope,
    db: &db::DbState,
    auth: &AuthState,
) -> Result<(), PrivilegedActionError> {
    authorize_privileged_action_at(scope, db, auth, Utc::now()).map(|_| ())
}

fn confirm_privileged_action_at(
    arg0: Option<Value>,
    db: &db::DbState,
    auth: &AuthState,
    now: DateTime<Utc>,
) -> Result<Value, PrivilegedActionError> {
    let payload = arg0.ok_or_else(|| {
        PrivilegedActionError::unauthorized(None, "Missing privileged action confirmation payload")
    })?;
    let pin = extract_pin(&payload).ok_or_else(|| {
        PrivilegedActionError::unauthorized(None, "PIN is required for privileged confirmation")
    })?;
    let scope = extract_scope(&payload)
        .ok_or_else(|| PrivilegedActionError::unauthorized(None, "Invalid privileged scope"))?;

    let session = match scope {
        PrivilegedActionScope::SystemControl => {
            match get_current_session(auth) {
                Some(session) if session.role == "admin" => session,
                Some(_) => {
                    return Err(PrivilegedActionError::unauthorized(
                        Some(scope),
                        "Active admin session required",
                    ));
                }
                None => {
                    // No active session — create a temporary admin session so the
                    // privileged-grant chain works. PIN verified by standard flow below.
                    let _ = create_session(auth, "admin", "system-control");
                    get_current_session(auth).ok_or_else(|| {
                        PrivilegedActionError::unauthorized(
                            Some(scope),
                            "Failed to create temporary session",
                        )
                    })?
                }
            }
        }
        PrivilegedActionScope::CashDrawerControl => {
            let Some(session) = get_current_session(auth) else {
                return Err(PrivilegedActionError::unauthorized(
                    Some(scope),
                    "Active session required",
                ));
            };
            match current_terminal_has_cash_drawer_role(db) {
                Ok(true) => session,
                Ok(false) => {
                    return Err(PrivilegedActionError::unauthorized(
                        Some(scope),
                        "Active cashier or manager shift required on this terminal",
                    ));
                }
                Err(error) => {
                    return Err(PrivilegedActionError::unauthorized(Some(scope), error));
                }
            }
        }
    };

    let pin_ok = verify_pin_for_session(&pin, &session, db)
        .map_err(|error| PrivilegedActionError::unauthorized(Some(scope), error))?;
    if !pin_ok {
        return Err(PrivilegedActionError::unauthorized(
            Some(scope),
            "Invalid PIN",
        ));
    }

    let expires_at = record_privileged_grant_at(auth, &session.session_id, scope, now)
        .map_err(|error| PrivilegedActionError::unauthorized(Some(scope), error))?;

    Ok(serde_json::json!({
        "success": true,
        "scope": scope.as_str(),
        "sessionId": session.session_id,
        "ttlSeconds": PRIVILEGED_ACTION_TTL_SECONDS,
        "expiresAt": expires_at.to_rfc3339(),
    }))
}

pub fn confirm_privileged_action(
    arg0: Option<Value>,
    db: &db::DbState,
    auth: &AuthState,
) -> Result<Value, PrivilegedActionError> {
    confirm_privileged_action_at(arg0, db, auth, Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn test_db_state() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    fn lockout_attempts(db_state: &db::DbState) -> u32 {
        let conn = db_state.conn.lock().expect("db lock");
        db::get_setting(&conn, "staff", LOCKOUT_ATTEMPTS_KEY)
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0)
    }

    fn set_pin_hash(db_state: &db::DbState, key: &str, pin: &str) {
        let conn = db_state.conn.lock().expect("db lock");
        let hash = bcrypt::hash(pin, 4).expect("hash test pin");
        db::set_setting(&conn, "staff", key, &hash).expect("store pin hash");
    }

    fn set_staff_auth_cache(
        db_state: &db::DbState,
        branch_id: &str,
        staff_entries: serde_json::Value,
    ) {
        let conn = db_state.conn.lock().expect("db lock");
        let payload = serde_json::json!({
            "version": 1,
            "branch_id": branch_id,
            "synced_at": Utc::now().to_rfc3339(),
            "staff": staff_entries,
        });
        db::set_setting(
            &conn,
            STAFF_AUTH_CACHE_CATEGORY,
            &staff_auth_cache_key(branch_id),
            &payload.to_string(),
        )
        .expect("store staff auth cache");
    }

    fn set_terminal_id(db_state: &db::DbState, terminal_id: &str) {
        let conn = db_state.conn.lock().expect("db lock");
        db::set_setting(&conn, "terminal", "terminal_id", terminal_id).expect("store terminal id");
    }

    fn insert_active_shift(db_state: &db::DbState, terminal_id: &str, role_type: &str) {
        let now = Utc::now().to_rfc3339();
        let conn = db_state.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?7, ?7)",
            rusqlite::params![
                format!("shift-{role_type}"),
                format!("staff-{role_type}"),
                format!("{role_type} staff"),
                "branch-1",
                terminal_id,
                role_type,
                now,
            ],
        )
        .expect("insert active shift");
    }

    fn current_session_id(auth: &AuthState) -> String {
        auth.current_session_id
            .lock()
            .expect("session lock")
            .clone()
            .expect("current session id")
    }

    fn login_as_admin(db_state: &db::DbState, auth: &AuthState) {
        set_pin_hash(db_state, "admin_pin_hash", "1234");
        login(Some(serde_json::json!({ "pin": "1234" })), db_state, auth).expect("admin login");
    }

    fn login_as_staff(db_state: &db::DbState, auth: &AuthState) {
        set_pin_hash(db_state, "staff_pin_hash", "4321");
        login(Some(serde_json::json!({ "pin": "4321" })), db_state, auth).expect("staff login");
    }

    #[test]
    fn lockout_persists_across_auth_state_restart() {
        let db_state = test_db_state();
        let auth_before_restart = AuthState::new();

        for _ in 0..MAX_FAILED_ATTEMPTS {
            let err = login(
                Some(serde_json::json!({ "pin": "9999" })),
                &db_state,
                &auth_before_restart,
            )
            .expect_err("invalid login should fail");
            assert_eq!(err, "Invalid PIN");
        }

        assert_eq!(lockout_attempts(&db_state), MAX_FAILED_ATTEMPTS);

        let auth_after_restart = AuthState::new();
        let err = login(
            Some(serde_json::json!({ "pin": "9999" })),
            &db_state,
            &auth_after_restart,
        )
        .expect_err("lockout should remain active after restart");

        assert!(
            err.contains("Too many failed attempts"),
            "unexpected lockout error message: {err}"
        );
        assert_eq!(
            lockout_attempts(&db_state),
            MAX_FAILED_ATTEMPTS,
            "blocked attempt should not increment counter while lockout is active"
        );
    }

    #[test]
    fn successful_login_resets_persisted_lockout_after_restart() {
        let db_state = test_db_state();
        {
            let conn = db_state.conn.lock().expect("db lock");
            let admin_hash = bcrypt::hash("1234", 4).expect("hash test pin");
            db::set_setting(&conn, "staff", "admin_pin_hash", &admin_hash)
                .expect("store admin hash");
        }

        let auth_before_restart = AuthState::new();
        for _ in 0..2 {
            let err = login(
                Some(serde_json::json!({ "pin": "9999" })),
                &db_state,
                &auth_before_restart,
            )
            .expect_err("invalid login should fail");
            assert_eq!(err, "Invalid PIN");
        }
        assert_eq!(lockout_attempts(&db_state), 2);

        let auth_after_restart = AuthState::new();
        let result = login(
            Some(serde_json::json!({ "pin": "1234" })),
            &db_state,
            &auth_after_restart,
        )
        .expect("valid login should succeed");
        assert_eq!(result.get("success").and_then(Value::as_bool), Some(true));
        assert_eq!(
            lockout_attempts(&db_state),
            0,
            "successful login should persist reset lockout counter"
        );

        let auth_after_second_restart = AuthState::new();
        let err = login(
            Some(serde_json::json!({ "pin": "9999" })),
            &db_state,
            &auth_after_second_restart,
        )
        .expect_err("invalid login should fail after reset");
        assert_eq!(err, "Invalid PIN");
        assert_eq!(lockout_attempts(&db_state), 1);
    }

    #[test]
    fn verify_staff_check_in_pin_accepts_valid_cached_staff_pin() {
        let db_state = test_db_state();
        let hash = bcrypt::hash("4321", 4).expect("hash test pin");
        set_staff_auth_cache(
            &db_state,
            "branch-1",
            serde_json::json!([
                {
                    "id": "staff-1",
                    "can_login_pos": true,
                    "has_pin": true,
                    "pin_hash": hash,
                    "is_active": true
                }
            ]),
        );

        let result = verify_staff_check_in_pin(
            Some(serde_json::json!({
                "staffId": "staff-1",
                "branchId": "branch-1",
                "pin": "4321"
            })),
            &db_state,
        )
        .expect("verification should succeed");

        assert_eq!(result.get("success").and_then(Value::as_bool), Some(true));
        assert_eq!(
            result.get("staffId").and_then(Value::as_str),
            Some("staff-1")
        );
    }

    #[test]
    fn verify_staff_check_in_pin_rejects_wrong_pin() {
        let db_state = test_db_state();
        let hash = bcrypt::hash("4321", 4).expect("hash test pin");
        set_staff_auth_cache(
            &db_state,
            "branch-1",
            serde_json::json!([
                {
                    "id": "staff-1",
                    "can_login_pos": true,
                    "has_pin": true,
                    "pin_hash": hash
                }
            ]),
        );

        let result = verify_staff_check_in_pin(
            Some(serde_json::json!({
                "staffId": "staff-1",
                "branchId": "branch-1",
                "pin": "9999"
            })),
            &db_state,
        )
        .expect("verification should return structured failure");

        assert_eq!(result.get("success").and_then(Value::as_bool), Some(false));
        assert_eq!(
            result.get("reasonCode").and_then(Value::as_str),
            Some("invalid_pin")
        );
    }

    #[test]
    fn verify_staff_check_in_pin_rejects_missing_pin_configuration() {
        let db_state = test_db_state();
        set_staff_auth_cache(
            &db_state,
            "branch-1",
            serde_json::json!([
                {
                    "id": "staff-1",
                    "can_login_pos": true,
                    "has_pin": false,
                    "pin_hash": null
                }
            ]),
        );

        let result = verify_staff_check_in_pin(
            Some(serde_json::json!({
                "staffId": "staff-1",
                "branchId": "branch-1",
                "pin": "4321"
            })),
            &db_state,
        )
        .expect("verification should return structured failure");

        assert_eq!(result.get("success").and_then(Value::as_bool), Some(false));
        assert_eq!(
            result.get("reasonCode").and_then(Value::as_str),
            Some("pin_not_configured")
        );
    }

    #[test]
    fn verify_staff_check_in_pin_rejects_pos_disabled_staff() {
        let db_state = test_db_state();
        let hash = bcrypt::hash("4321", 4).expect("hash test pin");
        set_staff_auth_cache(
            &db_state,
            "branch-1",
            serde_json::json!([
                {
                    "id": "staff-1",
                    "can_login_pos": false,
                    "has_pin": true,
                    "pin_hash": hash
                }
            ]),
        );

        let result = verify_staff_check_in_pin(
            Some(serde_json::json!({
                "staffId": "staff-1",
                "branchId": "branch-1",
                "pin": "4321"
            })),
            &db_state,
        )
        .expect("verification should return structured failure");

        assert_eq!(result.get("success").and_then(Value::as_bool), Some(false));
        assert_eq!(
            result.get("reasonCode").and_then(Value::as_str),
            Some("pos_login_disabled")
        );
    }

    #[test]
    fn verify_staff_check_in_pin_rejects_when_cache_is_missing() {
        let db_state = test_db_state();

        let result = verify_staff_check_in_pin(
            Some(serde_json::json!({
                "staffId": "staff-1",
                "branchId": "branch-1",
                "pin": "4321"
            })),
            &db_state,
        )
        .expect("verification should return structured failure");

        assert_eq!(result.get("success").and_then(Value::as_bool), Some(false));
        assert_eq!(
            result.get("reasonCode").and_then(Value::as_str),
            Some("staff_auth_unavailable")
        );
    }

    #[test]
    fn confirm_privileged_action_accepts_admin_system_control_pin() {
        let db_state = test_db_state();
        let auth = AuthState::new();
        login_as_admin(&db_state, &auth);

        let result = confirm_privileged_action(
            Some(serde_json::json!({
                "pin": "1234",
                "scope": "system_control"
            })),
            &db_state,
            &auth,
        )
        .expect("system control confirmation should succeed");

        assert_eq!(result.get("success").and_then(Value::as_bool), Some(true));
        assert_eq!(
            authorize_privileged_action(PrivilegedActionScope::SystemControl, &db_state, &auth),
            Ok(())
        );
    }

    #[test]
    fn confirm_privileged_action_rejects_wrong_pin() {
        let db_state = test_db_state();
        let auth = AuthState::new();
        login_as_admin(&db_state, &auth);

        let error = confirm_privileged_action(
            Some(serde_json::json!({
                "pin": "9999",
                "scope": "system_control"
            })),
            &db_state,
            &auth,
        )
        .expect_err("wrong pin should fail");

        assert_eq!(error.code, "UNAUTHORIZED");
        assert_eq!(error.scope, "system_control");
        assert_eq!(error.reason, "Invalid PIN");
    }

    #[test]
    fn privileged_grants_are_scope_isolated() {
        let db_state = test_db_state();
        let auth = AuthState::new();
        login_as_admin(&db_state, &auth);
        set_terminal_id(&db_state, "terminal-1");
        insert_active_shift(&db_state, "terminal-1", "manager");

        confirm_privileged_action(
            Some(serde_json::json!({
                "pin": "1234",
                "scope": "system_control"
            })),
            &db_state,
            &auth,
        )
        .expect("system control confirmation should succeed");

        let error = authorize_privileged_action_at(
            PrivilegedActionScope::CashDrawerControl,
            &db_state,
            &auth,
            Utc::now(),
        )
        .expect_err("system_control grant must not satisfy cash_drawer_control");

        assert_eq!(error.code, "REAUTH_REQUIRED");
        assert_eq!(error.scope, "cash_drawer_control");
        assert_eq!(error.ttl_seconds, Some(PRIVILEGED_ACTION_TTL_SECONDS));
    }

    #[test]
    fn privileged_grants_expire_after_ttl() {
        let db_state = test_db_state();
        let auth = AuthState::new();
        login_as_admin(&db_state, &auth);

        let granted_at = Utc::now();
        confirm_privileged_action_at(
            Some(serde_json::json!({
                "pin": "1234",
                "scope": "system_control"
            })),
            &db_state,
            &auth,
            granted_at,
        )
        .expect("system control confirmation should succeed");

        let error = authorize_privileged_action_at(
            PrivilegedActionScope::SystemControl,
            &db_state,
            &auth,
            granted_at + Duration::seconds(PRIVILEGED_ACTION_TTL_SECONDS + 1),
        )
        .expect_err("expired grant should require re-auth");

        assert_eq!(error.code, "REAUTH_REQUIRED");
        assert_eq!(error.scope, "system_control");
    }

    #[test]
    fn system_control_requires_admin_session() {
        let db_state = test_db_state();
        let auth = AuthState::new();
        login_as_staff(&db_state, &auth);

        let error = confirm_privileged_action(
            Some(serde_json::json!({
                "pin": "4321",
                "scope": "system_control"
            })),
            &db_state,
            &auth,
        )
        .expect_err("staff session must not confirm system control");

        assert_eq!(error.code, "UNAUTHORIZED");
        assert_eq!(error.scope, "system_control");
        assert!(error.reason.contains("admin"));
    }

    #[test]
    fn cash_drawer_control_accepts_cashier_shift() {
        let db_state = test_db_state();
        let auth = AuthState::new();
        login_as_staff(&db_state, &auth);
        set_terminal_id(&db_state, "terminal-cashier");
        insert_active_shift(&db_state, "terminal-cashier", "cashier");

        confirm_privileged_action(
            Some(serde_json::json!({
                "pin": "4321",
                "scope": "cash_drawer_control"
            })),
            &db_state,
            &auth,
        )
        .expect("cashier shift should allow drawer control confirmation");

        assert_eq!(
            authorize_privileged_action(PrivilegedActionScope::CashDrawerControl, &db_state, &auth),
            Ok(())
        );
    }

    #[test]
    fn cash_drawer_control_accepts_manager_shift() {
        let db_state = test_db_state();
        let auth = AuthState::new();
        login_as_staff(&db_state, &auth);
        set_terminal_id(&db_state, "terminal-manager");
        insert_active_shift(&db_state, "terminal-manager", "manager");

        let result = confirm_privileged_action(
            Some(serde_json::json!({
                "pin": "4321",
                "scope": "cash_drawer_control"
            })),
            &db_state,
            &auth,
        )
        .expect("manager shift should allow drawer control confirmation");

        assert_eq!(
            result.get("scope").and_then(Value::as_str),
            Some("cash_drawer_control")
        );
    }

    #[test]
    fn cash_drawer_control_rejects_non_cashier_shift() {
        let db_state = test_db_state();
        let auth = AuthState::new();
        login_as_staff(&db_state, &auth);
        set_terminal_id(&db_state, "terminal-driver");
        insert_active_shift(&db_state, "terminal-driver", "driver");

        let error = confirm_privileged_action(
            Some(serde_json::json!({
                "pin": "4321",
                "scope": "cash_drawer_control"
            })),
            &db_state,
            &auth,
        )
        .expect_err("driver shift must not allow drawer control");

        assert_eq!(error.code, "UNAUTHORIZED");
        assert_eq!(error.scope, "cash_drawer_control");
        assert!(error.reason.contains("cashier or manager"));
    }

    #[test]
    fn logout_clears_privileged_grants_for_session() {
        let db_state = test_db_state();
        let auth = AuthState::new();
        login_as_admin(&db_state, &auth);
        let session_id = current_session_id(&auth);
        confirm_privileged_action(
            Some(serde_json::json!({
                "pin": "1234",
                "scope": "system_control"
            })),
            &db_state,
            &auth,
        )
        .expect("system control confirmation should succeed");
        assert!(has_fresh_privileged_grant_at(
            &auth,
            &session_id,
            PrivilegedActionScope::SystemControl,
            Utc::now()
        ));

        logout(&auth);

        assert!(!has_fresh_privileged_grant_at(
            &auth,
            &session_id,
            PrivilegedActionScope::SystemControl,
            Utc::now()
        ));
    }
}
