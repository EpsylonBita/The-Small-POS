//! Desktop dual-key receiver. Secrets live only in the OS keyring and transient
//! zeroizing buffers. Existing audit rows are the non-secret recovery journal;
//! no business or support schema migration is needed.
use super::{audit_local, session::Runtime};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    pin::Pin,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub const FETCH: &str = "/api/pos/support/key-rotation";
pub const CONFIRM: &str = "/api/pos/support/key-rotation/confirm";
const HANDOVER: Duration = Duration::from_secs(72 * 3600);
/// Confirm revokes the old key. Waiting this long after the new key is written
/// lets requests that captured the old key (a sync pass, an order-status push,
/// a menu fetch) finish inside the server's dual-key handover, so none of them
/// meets a 401 that could pause sync or stall a sale.
const CONFIRM_GRACE: Duration = Duration::from_secs(10 * 60);
#[cfg(test)]
thread_local! {
    /// Tests confirm at once unless they opt into the real grace.
    pub static TEST_CONFIRM_GRACE: std::cell::Cell<Option<Duration>> =
        const { std::cell::Cell::new(Some(Duration::ZERO)) };
}
fn confirm_grace() -> Duration {
    #[cfg(test)]
    if let Some(grace) = TEST_CONFIRM_GRACE.with(|g| g.get()) {
        return grace;
    }
    CONFIRM_GRACE
}

pub fn hash(key: &str) -> String {
    // Existing callers may retain either a legacy connection string or its
    // decoded header key. Both must identify the same handover credential.
    let key = Zeroizing::new(
        crate::api::extract_api_key_from_connection_string(key).unwrap_or_else(|| key.to_owned()),
    );
    crate::core_helpers::lower_hex(&Sha256::digest(key.as_bytes()))
}

// Deliberately no Debug/Serialize on the secret-bearing response.
pub struct Pending {
    pub new_api_key: Zeroizing<String>,
    pub issued_at: String,
}
pub fn parse_fetch(mut value: Value) -> Result<Option<Pending>, Failure> {
    let pending = value["pending"].as_bool().ok_or(Failure::Invalid)?;
    super::clock::parse(value["server_time"].as_str().ok_or(Failure::Invalid)?)
        .map_err(|_| Failure::Invalid)?;
    if !pending {
        return Ok(None);
    }
    let key = value["new_api_key"].take();
    let Value::String(key) = key else {
        return Err(Failure::Invalid);
    };
    let key = Zeroizing::new(key);
    if key.is_empty()
        || key.len() > 4096
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Failure::Invalid);
    }
    let issued_at = value["issued_at"]
        .as_str()
        .ok_or(Failure::Invalid)?
        .to_owned();
    let issued = super::clock::parse(&issued_at).map_err(|_| Failure::Invalid)?;
    let revoke = super::clock::parse(value["revoke_old_at"].as_str().ok_or(Failure::Invalid)?)
        .map_err(|_| Failure::Invalid)?;
    if revoke - issued != HANDOVER.as_millis() as i64 {
        return Err(Failure::Invalid);
    }
    Ok(Some(Pending {
        new_api_key: key,
        issued_at,
    }))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirmed {
    pub promoted: bool,
    pub server_time: String,
}
pub fn parse_confirm(value: Value) -> Result<Confirmed, Failure> {
    let reply: Confirmed = serde_json::from_value(value).map_err(|_| Failure::Invalid)?;
    if !reply.promoted || super::clock::parse(&reply.server_time).is_err() {
        return Err(Failure::Invalid);
    }
    Ok(reply)
}
pub fn confirm_body(issued_at: &str) -> Value {
    json!({"issued_at":issued_at})
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Failure {
    Offline,
    Http(u16),
    Invalid,
    Storage,
    Deferred,
    #[cfg(test)]
    Crash,
}
pub type ReplyFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, Failure>> + Send + 'a>>;
pub trait Sender: Send + Sync {
    fn send<'a>(
        &'a self,
        key: &'a str,
        path: &'a str,
        method: &'a str,
        body: Option<Value>,
    ) -> ReplyFuture<'a>;
}

async fn send(
    sender: &dyn Sender,
    key: &str,
    path: &str,
    method: &str,
    body: Option<Value>,
) -> Result<Value, Failure> {
    tokio::time::timeout(
        super::transport::REQUEST_TIMEOUT,
        retry_authenticated(key, |key| {
            let body = body.clone();
            async move { sender.send(&key, path, method, body).await }
        }),
    )
    .await
    .map_err(|_| Failure::Offline)?
}

/// Shared retry seam: never retry a write on an ambiguous network failure.
/// A 401 proves that the first request was not authenticated/executed.
pub async fn retry_authenticated<F, Fut>(key: &str, mut send: F) -> Result<Value, Failure>
where
    F: FnMut(Zeroizing<String>) -> Fut,
    Fut: Future<Output = Result<Value, Failure>>,
{
    match send(Zeroizing::new(key.to_owned())).await {
        Err(Failure::Http(401)) => {
            let other = crate::storage::rotation_alternate(key).ok_or(Failure::Http(401))?;
            send(other).await
        }
        reply => reply,
    }
}

pub struct NativeSender {
    pub app: tauri::AppHandle,
}
impl Sender for NativeSender {
    fn send<'a>(
        &'a self,
        key: &'a str,
        path: &'a str,
        method: &'a str,
        body: Option<Value>,
    ) -> ReplyFuture<'a> {
        Box::pin(async move {
            use tauri::Manager;
            tokio::time::timeout(super::transport::REQUEST_TIMEOUT, async {
                let db = self.app.state::<crate::db::DbState>();
                let (base, _) = crate::resolve_admin_endpoint(Some(&db))
                    .await
                    .map_err(|_| Failure::Offline)?;
                super::transport::require_https(&base).map_err(|_| Failure::Invalid)?;
                crate::api::fetch_from_admin_detailed_with_timeout(
                    &base,
                    key,
                    path,
                    method,
                    body,
                    super::transport::REQUEST_TIMEOUT,
                )
                .await
                .map_err(|e| e.status().map(Failure::Http).unwrap_or(Failure::Offline))
            })
            .await
            .map_err(|_| Failure::Offline)?
        })
    }
}

pub struct State {
    pub issued_at: String,
    pub new_hash: String,
    pub phase: String,
}
pub fn load(conn: &Connection) -> Result<Option<State>, Failure> {
    conn.query_row("SELECT outcome,input_sha256,substr(status,14) FROM support_audit_local WHERE status IN ('key_rotation.fetched','key_rotation.written','key_rotation.confirmed','key_rotation.conflict') ORDER BY terminal_seq DESC LIMIT 1", [], |r| {
        let issued_at: String = r.get(0)?;
        Ok(State { issued_at:issued_at.replace('_', "+"), new_hash:r.get(1)?, phase:r.get(2)? })
    }).optional().map_err(|_| Failure::Storage)
}
fn save(rt: &Runtime, state: &State, phase: &str) -> Result<(), Failure> {
    let core = rt.core.lock().map_err(|_| Failure::Storage)?;
    let tx = super::db::transaction(&core.executor.db.conn).map_err(|_| Failure::Storage)?;
    audit_local::append(
        &tx,
        &audit_local::AuditEntry {
            terminal_seq: 0,
            session_id: None,
            command_id: None,
            phase: match phase {
                "fetched" => "accepted",
                "confirmed" => "finished",
                "conflict" => "refused",
                _ => "started",
            }
            .into(),
            status: Some(format!("key_rotation.{phase}")),
            // The audit label alphabet excludes '+'. Encode just that offset
            // separator reversibly; never truncate PostgreSQL microseconds or
            // change the issuance proof sent back to confirm.
            outcome: Some(state.issued_at.replace('+', "_")),
            input_sha256: Some(state.new_hash.clone()),
            result_sha256: None,
            created_at: super::clock::iso(chrono::Utc::now().timestamp_millis()),
        },
    )
    .map_err(|_| Failure::Storage)?;
    tx.commit().map_err(|_| Failure::Storage)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Crash {
    None,
    #[cfg(test)]
    AfterFetch,
    #[cfg(test)]
    BeforeWrite,
    #[cfg(test)]
    AfterWrite,
    #[cfg(test)]
    AfterConfirm,
}
fn checkpoint(crash: Crash, at: &str) -> Result<(), Failure> {
    #[cfg(test)]
    if matches!(
        (crash, at),
        (Crash::AfterFetch, "fetch")
            | (Crash::BeforeWrite, "write")
            | (Crash::AfterWrite, "confirm")
            | (Crash::AfterConfirm, "confirmed")
    ) {
        return Err(Failure::Crash);
    }
    let _ = (crash, at);
    Ok(())
}

pub async fn attempt(sender: &dyn Sender, rt: &Runtime, crash: Crash) -> Result<bool, Failure> {
    let permit = super::critical_op::global()
        .try_begin_support(true, None)
        .map_err(|_| Failure::Deferred)?;
    let state = {
        let core = rt.core.lock().map_err(|_| Failure::Storage)?;
        load(&core.executor.db.conn)?
    };
    let key = crate::storage::get_credential_strict("pos_api_key")
        .map_err(|_| Failure::Storage)?
        .ok_or(Failure::Storage)?;
    if let Some(s) = state
        .as_ref()
        .filter(|s| s.phase == "confirmed" && hash(&key) == s.new_hash)
    {
        // Finish cleanup if the process died after recording confirmation.
        crate::storage::finish_api_key_rotation(&s.new_hash).map_err(|_| Failure::Storage)?;
    }
    let fetched = send(sender, &key, FETCH, "GET", None).await;
    let state = match fetched {
        Ok(value) => {
            let pending = parse_fetch(value)?;
            if pending.is_none() {
                // The confirm reply may have been lost after server promotion.
                // Its idempotent confirm proves completion before local cleanup.
                let Some(s) = state.filter(|s| s.phase != "confirmed" && hash(&key) == s.new_hash)
                else {
                    return Ok(false);
                };
                return confirm(sender, rt, &permit, s, crash, false).await;
            }
            let pending = pending.ok_or(Failure::Invalid)?;
            checkpoint(crash, "fetch")?;
            if permit.is_cancelled() {
                return Err(Failure::Deferred);
            }
            let state = State {
                issued_at: pending.issued_at,
                new_hash: hash(&pending.new_api_key),
                phase: "fetched".into(),
            };
            save(rt, &state, "fetched")?;
            checkpoint(crash, "write")?;
            if permit.is_cancelled() {
                return Err(Failure::Deferred);
            }
            crate::storage::install_rotated_api_key(&key, &pending.new_api_key, &permit)
                .map_err(|_| Failure::Storage)?;
            save(rt, &state, "written")?;
            state
        }
        // Fetch deliberately requires the OLD key. After a crash following
        // keyring write, a verified saved hash + 403 is the confirm lane.
        Err(Failure::Http(403)) => state
            .filter(|s| s.phase != "confirmed" && hash(&key) == s.new_hash)
            .ok_or(Failure::Http(403))?,
        Err(error) => return Err(error),
    };
    confirm(sender, rt, &permit, state, crash, true).await
}

/// When the new key was verified in the keyring, from the journal. A missing
/// record (a crash right after the write) starts the grace now.
fn written_at(rt: &Runtime, state: &State) -> Result<i64, Failure> {
    let core = rt.core.lock().map_err(|_| Failure::Storage)?;
    let at: Option<String> = core
        .executor
        .db
        .conn
        .query_row(
            "SELECT created_at FROM support_audit_local WHERE status='key_rotation.written' AND input_sha256=?1 ORDER BY terminal_seq DESC LIMIT 1",
            [&state.new_hash],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| Failure::Storage)?;
    drop(core);
    match at.and_then(|at| super::clock::parse(&at).ok()) {
        Some(at) => Ok(at),
        None => {
            save(rt, state, "written")?;
            Ok(chrono::Utc::now().timestamp_millis())
        }
    }
}

async fn confirm(
    sender: &dyn Sender,
    rt: &Runtime,
    permit: &super::critical_op::SupportPermit,
    state: State,
    crash: Crash,
    grace: bool,
) -> Result<bool, Failure> {
    if grace {
        let written = written_at(rt, &state)?;
        let elapsed = chrono::Utc::now()
            .timestamp_millis()
            .saturating_sub(written);
        if elapsed < confirm_grace().as_millis() as i64 {
            // Not a failure: the schedule retries, both keys stay valid.
            return Err(Failure::Deferred);
        }
    }
    checkpoint(crash, "confirm")?;
    if permit.is_cancelled() {
        return Err(Failure::Deferred);
    }
    let new_key = crate::storage::get_credential_strict("pos_api_key")
        .map_err(|_| Failure::Storage)?
        .ok_or(Failure::Storage)?;
    if hash(&new_key) != state.new_hash {
        return Err(Failure::Storage);
    }
    let reply = send(
        sender,
        &new_key,
        CONFIRM,
        "POST",
        Some(confirm_body(&state.issued_at)),
    )
    .await;
    match reply {
        Ok(value) => {
            parse_confirm(value)?;
        }
        Err(error) => {
            if error == Failure::Http(409) {
                save(rt, &state, "conflict")?;
            }
            return Err(error);
        }
    }
    checkpoint(crash, "confirmed")?;
    save(rt, &state, "confirmed")?;
    crate::storage::finish_api_key_rotation(&state.new_hash).map_err(|_| Failure::Storage)?;
    Ok(true)
}

#[derive(Default)]
pub struct Schedule {
    until: Option<Instant>,
    next: Option<Instant>,
    attempts: u32,
}
impl Schedule {
    pub fn arm(&mut self, now: Instant) {
        if self.until.is_none() {
            self.until = Some(now + HANDOVER);
            self.next = Some(now);
            self.attempts = 0;
        }
    }
    pub fn due(&mut self, now: Instant) -> bool {
        if self.until.is_none_or(|until| now >= until) {
            self.until = None;
            self.next = None;
            return false;
        }
        if self.next.is_none_or(|next| now < next) {
            return false;
        }
        self.next = Some(
            now + Duration::from_secs((5u64.saturating_mul(1u64 << self.attempts.min(6))).min(300)),
        );
        self.attempts = self.attempts.saturating_add(1);
        true
    }
    pub fn stop(&mut self) {
        self.until = None;
        self.next = None;
    }
    pub fn resume(conn: &Connection) -> Result<Self, Failure> {
        let mut schedule = Self::default();
        let state = load(conn)?;
        let issued = state
            .as_ref()
            .filter(|s| s.phase != "confirmed")
            .and_then(|s| super::clock::parse(&s.issued_at).ok());
        // Also cover a crash between fetch and the first journal record, and
        // a server end whose lifecycle cleanup had not yet minted the key.
        let last: Option<String> = conn.query_row("SELECT max(s.updated_at) FROM support_accepted_commands c JOIN support_session_state s ON s.session_id=c.session_id WHERE c.kind='breakglass_propose_command' AND c.started_at IS NOT NULL AND s.status='ended'", [], |r| r.get(0)).map_err(|_| Failure::Storage)?;
        let last = last
            .and_then(|s| super::clock::parse(&s).ok())
            .filter(|at| {
                state
                    .as_ref()
                    .filter(|s| s.phase == "confirmed")
                    .and_then(|s| super::clock::parse(&s.issued_at).ok())
                    .is_none_or(|confirmed| *at > confirmed)
            });
        let at = issued.or(last);
        if let Some(at) = at {
            let remaining = at
                .saturating_add(HANDOVER.as_millis() as i64)
                .saturating_sub(chrono::Utc::now().timestamp_millis());
            if remaining > 0 {
                let now = Instant::now();
                schedule.arm(now);
                schedule.until = Some(now + Duration::from_millis(remaining as u64));
            }
        }
        Ok(schedule)
    }
}

pub async fn cycle(sender: &dyn Sender, rt: &Runtime) {
    let due = rt
        .core
        .lock()
        .map(|mut core| core.rotation.due(Instant::now()))
        .unwrap_or(false);
    if !due {
        return;
    }
    if let Ok(true) = attempt(sender, rt, Crash::None).await {
        if let Ok(mut core) = rt.core.lock() {
            core.rotation.stop();
        }
    }
}
