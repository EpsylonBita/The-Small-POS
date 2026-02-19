//! PIN-based local authentication with bcrypt.
//!
//! Provides admin and staff login, session management, lockout tracking,
//! and permission checking. PIN hashes are stored in the SQLite
//! `local_settings` table (category "staff", keys "admin_pin_hash" /
//! "staff_pin_hash"). Sessions are kept in-memory; the `staff_sessions`
//! table is used only for audit/persistence across restarts.

use chrono::{DateTime, Duration, Utc};
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
#[derive(Clone)]
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

/// Tauri managed state for authentication.
pub struct AuthState {
    sessions: Mutex<HashMap<String, StaffSession>>,
    current_session_id: Mutex<Option<String>>,
    lockout: Mutex<LockoutEntry>,
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

    {
        let mut sessions = auth.sessions.lock().unwrap();
        sessions.insert(sid.clone(), session);
    }
    {
        let mut current = auth.current_session_id.lock().unwrap();
        *current = Some(sid);
    }

    serde_json::json!({
        "success": true,
        "user": user_json,
    })
}

/// Get the current active session (if it exists and is not expired).
fn get_current_session(auth: &AuthState) -> Option<StaffSession> {
    let current_id = auth.current_session_id.lock().unwrap().clone()?;
    let sessions = auth.sessions.lock().unwrap();
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

    // Check lockout
    {
        let lockout = auth.lockout.lock().unwrap();
        check_lockout(&lockout)?;
    }

    // Read PIN hashes from the database
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let admin_hash = db::get_setting(&conn, "staff", "admin_pin_hash");
    let staff_hash = db::get_setting(&conn, "staff", "staff_pin_hash");

    // Try admin PIN first
    if let Some(ref hash) = admin_hash {
        if bcrypt::verify(&pin, hash).unwrap_or(false) {
            reset_lockout(&mut auth.lockout.lock().unwrap());
            info!("admin login successful");
            return Ok(create_session(auth, "admin", "admin-user"));
        }
    }

    // Try staff PIN
    if let Some(ref hash) = staff_hash {
        if bcrypt::verify(&pin, hash).unwrap_or(false) {
            reset_lockout(&mut auth.lockout.lock().unwrap());
            info!("staff login successful");
            return Ok(create_session(auth, "staff", "staff-user"));
        }
    }

    // Neither matched
    record_failure(&mut auth.lockout.lock().unwrap());
    Err("Invalid PIN".into())
}

/// Handle auth:logout — invalidate the current session.
pub fn logout(auth: &AuthState) {
    let mut current = auth.current_session_id.lock().unwrap();
    if let Some(sid) = current.take() {
        let mut sessions = auth.sessions.lock().unwrap();
        sessions.remove(&sid);
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
            let mut current = auth.current_session_id.lock().unwrap();
            if let Some(sid) = current.take() {
                let mut sessions = auth.sessions.lock().unwrap();
                sessions.remove(&sid);
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

    // Validate: numeric, at least 4 digits
    fn validate_pin(pin: &str, label: &str) -> Result<(), String> {
        if pin.len() < 4 {
            return Err(format!("{label} must be at least 4 digits"));
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

    Ok(serde_json::json!({ "success": true }))
}

/// Handle staff-auth:track-activity — refresh the inactivity timer.
pub fn track_activity(auth: &AuthState) {
    let current_id = auth.current_session_id.lock().unwrap().clone();
    if let Some(sid) = current_id {
        let mut sessions = auth.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&sid) {
            session.last_activity = Utc::now();
        }
    }
}

/// Handle staff-auth:get-current — return current user info or null.
pub fn get_current_user(auth: &AuthState) -> Value {
    get_session_json(auth)
}
