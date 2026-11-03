//! Outbound transport. The scheduler is monotonic and owns no business connection.
use super::contracts::cap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
// Worst case: 5 s since the last start + 3 s request + 0.5 s tick.
const SERVER_CHECK_INTERVAL: Duration = Duration::from_secs(5);
pub(super) const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub operator_display_name: String,
    pub tier_ceiling: u8,
    pub max_expires_at: String,
    pub absolute_cap_at: String,
    pub idle_timeout_s: u64,
    pub ack_deadline_at: String,
    pub doorbell_topic: String,
    pub resume_allowed: bool,
}
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
pub struct SessionFetch {
    pub state: String,
    pub session: Option<SessionInfo>,
    // Used by task 8.9 (Phase 1 transport loop).
    #[allow(dead_code)]
    #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
    pub code: Option<Value>,
    pub server_time: String,
    #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
    pub end_reason: Option<String>,
    // Used by task 8.9 (Phase 1 transport loop).
    #[allow(dead_code)]
    pub unattended: Option<Value>,
}
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
pub struct Heartbeat {
    pub available: bool,
    pub min_protocol_version: u64,
    pub tiers_enabled: Vec<u8>,
    // Used by task 8.9 (Phase 1 transport loop).
    #[allow(dead_code)]
    pub passkey_approvals: bool,
    pub disabled_tools: Vec<String>,
    pub kill_epoch: i64,
    pub consent: Value,
    pub session_status: String,
    #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
    pub end_reason: Option<String>,
    pub max_expires_at: String,
    pub tier_ceiling: u8,
    pub unattended: Option<Value>,
    pub revoked_key_ids: Vec<String>,
    pub key_rotation_pending: bool,
    pub next_seq_available: i64,
    pub server_time: String,
}
#[derive(Default)]
pub struct Schedule {
    pub doorbell_healthy: bool,
    pub rung: bool,
    last_poll: Option<Instant>,
    last_heartbeat: Option<Instant>,
    failure_since: Option<Instant>,
}
#[derive(Debug, Default, Eq, PartialEq)]
pub struct Due {
    pub session: bool,
    pub heartbeat: bool,
    pub commands: bool,
}
impl Schedule {
    pub fn due(&mut self, exists: bool, active: bool, now: Instant) -> Due {
        if !exists {
            return Due::default();
        }
        let heartbeat = active
            && self
                .last_heartbeat
                .is_none_or(|at| now.duration_since(at) >= SERVER_CHECK_INTERVAL);
        if heartbeat {
            self.last_heartbeat = Some(now);
        }
        let poll_ms = if self.doorbell_healthy {
            30_000
        } else {
            cap("transport", "fallbackPollMs")
        };
        let poll = self.rung
            || self
                .last_poll
                .is_none_or(|at| now.duration_since(at) >= Duration::from_millis(poll_ms));
        if poll {
            self.last_poll = Some(now);
            self.rung = false;
        }
        Due {
            session: !active && poll,
            heartbeat: active && heartbeat,
            commands: active && poll,
        }
    }
    pub fn failure(&mut self, now: Instant) {
        self.failure_since.get_or_insert(now);
        self.doorbell_healthy = false;
    }
    pub fn success(&mut self) {
        self.failure_since = None;
    }
    // Used by task 8.9 (Phase 1 transport loop).
    #[allow(dead_code)]
    pub fn paused(&self, now: Instant) -> bool {
        self.failure_since.is_some_and(|at| {
            now.duration_since(at) >= Duration::from_millis(cap("transport", "showPausedMs"))
        })
    }
}

pub fn require_https(base: &str) -> Result<(), String> {
    let url = url::Url::parse(base).map_err(|_| "TILL_OFFLINE")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("TILL_OFFLINE".into());
    }
    Ok(())
}

/// Uses the existing terminal-authenticated client, with a support-specific deadline.
pub async fn request(
    app: &tauri::AppHandle,
    path: &str,
    method: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    request_with_staff_session(app, path, method, body, None).await
}
async fn request_with_staff_session(
    app: &tauri::AppHandle,
    path: &str,
    method: &str,
    body: Option<Value>,
    staff_session: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager;
    // Include credential resolution and reply decoding inside the deadline.
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        crate::validate_admin_api_path(path).map_err(|_| "INVALID_INPUT")?;
        let db = app.state::<crate::db::DbState>();
        let (base, key) = crate::resolve_admin_endpoint(Some(&db))
            .await
            .map_err(|_| "TILL_OFFLINE")?;
        require_https(&base)?;
        let first = crate::api::fetch_from_admin_detailed_with_staff_session(
            &base,
            &key,
            path,
            method,
            body.clone(),
            staff_session,
            REQUEST_TIMEOUT,
        )
        .await;
        let reply = if first.as_ref().is_err_and(|e| e.status() == Some(401)) {
            if let Some(other) = crate::storage::rotation_alternate(&key) {
                crate::api::fetch_from_admin_detailed_with_staff_session(
                    &base,
                    &other,
                    path,
                    method,
                    body,
                    staff_session,
                    REQUEST_TIMEOUT,
                )
                .await
            } else {
                first
            }
        } else {
            first
        };
        reply.map_err(|e| {
            if e.code() == Some("SESSION_ENDED") || e.status() == Some(404) {
                "SESSION_ENDED".into()
            } else if e.status() == Some(401)
                || e.code() == Some("TERMINAL_AUTH_REFUSED")
                || (e.status() == Some(403) && e.code() != Some("POLICY_REFUSED"))
            {
                "TERMINAL_AUTH_REFUSED".into()
            } else if e.status() == Some(403) {
                "POLICY_REFUSED".into()
            } else {
                "TILL_OFFLINE".into()
            }
        })
    })
    .await
    .map_err(|_| "TILL_OFFLINE".to_string())?
}

pub(super) fn consent_accept_request(
    mut body: Value,
    staff: &Value,
    persisted: &Value,
) -> Result<(Value, String), String> {
    if body["staff_id"] != staff["databaseStaffId"]
        || persisted["staffId"] != staff["databaseStaffId"]
    {
        return Err("POLICY_REFUSED".into());
    }
    let staff_id = staff["databaseStaffId"].as_str().ok_or("POLICY_REFUSED")?;
    uuid::Uuid::parse_str(staff_id).map_err(|_| "POLICY_REFUSED")?;
    let session_id = persisted["sessionId"]
        .as_str()
        .ok_or("POLICY_REFUSED")?
        .to_owned();
    uuid::Uuid::parse_str(&session_id).map_err(|_| "POLICY_REFUSED")?;
    // The server binds the persisted checked-in session to this staff/branch
    // and re-resolves accepting roles. Renderer claims confer no authority.
    body["staff_id"] = json!(staff_id);
    Ok((body, session_id))
}
/// Only native time and a matching checked-in staff session enter the outbox.
pub(super) fn consent_decline_notice(
    text: &Value,
    staff: &Value,
    persisted: &Value,
    now: i64,
) -> Result<Value, String> {
    let object = text.as_object().ok_or("INVALID_INPUT")?;
    if object.len() != 2 {
        return Err("INVALID_INPUT".into());
    }
    let id = text["text_id"].as_str().ok_or("INVALID_INPUT")?;
    uuid::Uuid::parse_str(id).map_err(|_| "INVALID_INPUT")?;
    let hash = text["text_sha256"].as_str().ok_or("INVALID_INPUT")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("INVALID_INPUT".into());
    }
    let (_, session_id) = consent_accept_request(
        json!({"staff_id":staff["databaseStaffId"]}),
        staff,
        persisted,
    )?;
    Ok(
        json!({"text_id":id,"text_sha256":hash,"declined_at_till":super::clock::iso(now),"staff_session_id":session_id}),
    )
}

fn persisted_staff_session() -> Result<Value, String> {
    let raw = crate::storage::session_get_strict()
        .map_err(|_| "POLICY_REFUSED")?
        .ok_or("POLICY_REFUSED")?;
    serde_json::from_str(&raw).map_err(|_| "POLICY_REFUSED".into())
}

fn consent_accept_bound_request(
    body: Option<Value>,
    staff: &Value,
) -> Result<(Value, String), String> {
    let persisted = persisted_staff_session()?;
    consent_accept_request(body.ok_or("INVALID_INPUT")?, staff, &persisted)
}

pub(super) async fn consent_accept(
    app: &tauri::AppHandle,
    body: Option<Value>,
    staff: Value,
) -> Result<Value, String> {
    let (body, session) =
        crate::database_lock::run_blocking_command("support_consent_accept", move || {
            consent_accept_bound_request(body, &staff)
        })
        .await?;
    request_with_staff_session(
        app,
        "/api/pos/support/consent/accept",
        "POST",
        Some(body),
        Some(&session),
    )
    .await
}

pub(super) fn queue_consent_decline(
    db: &super::db::SupportDb,
    text: &Value,
    staff: &Value,
    now: i64,
) -> Result<(), String> {
    let notice = consent_decline_notice(text, staff, &persisted_staff_session()?, now)?;
    super::session::queue_notice(db, "consent_decline", notice, now)
}

async fn bounded_request(
    api: &dyn SupportApi,
    path: &str,
    method: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    tokio::time::timeout(REQUEST_TIMEOUT, api.request(path, method, body))
        .await
        .map_err(|_| "TILL_OFFLINE".to_string())?
}
fn symptom_baseline(
    health: Result<Value, String>,
    errors: Result<Value, String>,
    modules: Result<Value, String>,
) -> Value {
    let health = health.ok();
    let mut issues: Vec<Value> = health
        .as_ref()
        .and_then(|v| v["issues"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v["code"].as_str().map(|code| json!(code)))
        .take(100)
        .collect();
    if health
        .as_ref()
        .is_none_or(|v| v["health_state"] == "unavailable")
    {
        issues.push(json!("health.observation_unavailable"));
    }
    let errors = errors
        .ok()
        .and_then(|v| v["codes"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .take(100)
        .map(|v| json!({"code":v["code"],"count":v["count"]}))
        .collect::<Vec<_>>();
    let modules = modules
        .ok()
        .and_then(|v| v["enabled_modules"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v["id"].as_str().map(|id| json!(id)))
        .take(100)
        .collect::<Vec<_>>();
    json!({"health_issue_codes":issues,"error_codes":errors,"module_context":modules})
}
fn collect_baseline(path: &std::path::Path) -> Value {
    let unavailable = || {
        symptom_baseline(
            Err("unavailable".into()),
            Err("unavailable".into()),
            Err("unavailable".into()),
        )
    };
    let Ok(permit) = super::critical_op::global().try_begin_support(false, None) else {
        return unavailable();
    };
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return unavailable();
    };
    let _ = conn.busy_timeout(Duration::ZERO);
    permit.guard_connection(&conn, Instant::now() + REQUEST_TIMEOUT);
    symptom_baseline(
        super::collectors::health::collect(&conn),
        super::collectors::error_codes::collect(&json!({"limit":100}), &permit),
        super::collectors::modules::collect(&conn),
    )
}

pub fn ack(id: &str, baseline: Value, capabilities: Vec<String>) -> Value {
    json!({"session_id":id,"protocol_version":super::contracts::shared().protocol["version"],"capabilities":capabilities,"pinned_approver_key_ids":[],"symptom_baseline":baseline})
}

pub type ApiFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>;
/// Preserve HTTP evidence only for the decline's explicit retirement rules.
#[derive(Debug)]
pub struct DeclineError {
    pub status: Option<u16>,
    pub code: Option<String>,
}
impl DeclineError {
    fn transient() -> Self {
        Self {
            status: None,
            code: None,
        }
    }
    fn permanent(&self) -> bool {
        self.status == Some(400)
            || (self.status == Some(403) && self.code.as_deref() == Some("POLICY_REFUSED"))
            || (self.status == Some(409) && self.code.as_deref() == Some("PAYLOAD_MISMATCH"))
    }
}
pub type DeclineFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, DeclineError>> + Send + 'a>>;
#[derive(Deserialize, Serialize)]
pub(super) struct ConsentDeclineResponse {
    recorded: bool,
    server_time: String,
}
pub(super) fn parse_consent_decline(value: Value) -> Result<ConsentDeclineResponse, String> {
    let response: ConsentDeclineResponse =
        serde_json::from_value(value).map_err(|_| "INVALID_INPUT")?;
    if !response.recorded || super::clock::parse(&response.server_time).is_err() {
        return Err("INVALID_INPUT".into());
    }
    Ok(response)
}
pub(super) fn consent_decline_request(notice: &Value) -> Result<(Value, String), String> {
    let staff = notice["staff_session_id"].as_str().ok_or("INVALID_INPUT")?;
    uuid::Uuid::parse_str(staff).map_err(|_| "INVALID_INPUT")?;
    let at = notice["declined_at_till"].as_str().ok_or("INVALID_INPUT")?;
    super::clock::parse(at).map_err(|_| "INVALID_INPUT")?;
    let id = notice["text_id"].as_str().ok_or("INVALID_INPUT")?;
    uuid::Uuid::parse_str(id).map_err(|_| "INVALID_INPUT")?;
    let hash = notice["text_sha256"].as_str().ok_or("INVALID_INPUT")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("INVALID_INPUT".into());
    }
    Ok((
        json!({"text_id":id,"text_sha256":hash,"declined_at_till":at}),
        staff.into(),
    ))
}
pub trait SupportApi: Send + Sync {
    fn request<'a>(&'a self, path: &'a str, method: &'a str, body: Option<Value>) -> ApiFuture<'a>;
    fn visible(&self) -> bool;
    fn consent_decline<'a>(&'a self, _body: Value, _staff: &'a str) -> DeclineFuture<'a> {
        Box::pin(async { Err(DeclineError::transient()) })
    }
    fn baseline(&self) -> ApiFuture<'_> {
        Box::pin(async {
            Ok(symptom_baseline(
                Err("unavailable".into()),
                Err("unavailable".into()),
                Err("unavailable".into()),
            ))
        })
    }
}
struct NativeApi {
    app: tauri::AppHandle,
}
impl SupportApi for NativeApi {
    fn request<'a>(&'a self, path: &'a str, method: &'a str, body: Option<Value>) -> ApiFuture<'a> {
        Box::pin(request(&self.app, path, method, body))
    }
    fn consent_decline<'a>(&'a self, body: Value, staff: &'a str) -> DeclineFuture<'a> {
        Box::pin(async move {
            use tauri::Manager;
            let db = self.app.state::<crate::db::DbState>();
            let (base, key) = crate::resolve_admin_endpoint(Some(&db))
                .await
                .map_err(|_| DeclineError::transient())?;
            require_https(&base).map_err(|_| DeclineError::transient())?;
            crate::api::fetch_from_admin_detailed_with_staff_session(
                &base,
                &key,
                "/api/pos/support/consent/decline",
                "POST",
                Some(body),
                Some(staff),
                REQUEST_TIMEOUT,
            )
            .await
            .map_err(|e| DeclineError {
                status: e.status(),
                code: e.code().map(str::to_owned),
            })
        })
    }
    fn baseline(&self) -> ApiFuture<'_> {
        let app = self.app.clone();
        Box::pin(async move {
            use tauri::Manager;
            let path = app.state::<crate::db::DbState>().db_path.clone();
            tokio::task::spawn_blocking(move || collect_baseline(&path))
                .await
                .map_err(|_| "INTERNAL_ERROR".to_string())
        })
    }
    fn visible(&self) -> bool {
        super::dispatch::window_visible(&self.app)
    }
}

pub async fn run(app: tauri::AppHandle, rt: std::sync::Arc<super::session::Runtime>) {
    let rotation_rt = rt.clone();
    let rotation_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let sender = super::key_rotation::NativeSender { app: rotation_app };
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            // The receiver's schedule expires after 72 hours; idle ticks do
            // no network I/O and never hold a business connection/checkout.
            super::key_rotation::cycle(&sender, &rotation_rt).await;
        }
    });
    // Status runs independently of command/result requests. A slow request on
    // those lanes cannot postpone the next liveness/kill-switch observation.
    let status_rt = rt.clone();
    let status_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let api = NativeApi { app: status_app };
        status_lane(&api, &status_rt).await;
    });
    let delivery_rt = rt.clone();
    let delivery_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(3));
        loop {
            ticker.tick().await;
            let _ = flush(
                &NativeApi {
                    app: delivery_app.clone(),
                },
                &delivery_rt,
            )
            .await;
        }
    });
    let dispatch_rt = rt.clone();
    let dispatch_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        loop {
            ticker.tick().await;
            super::dispatch::drive(&dispatch_app, &dispatch_rt).await;
        }
    });
    let api = NativeApi { app: app.clone() };
    let mut ticker = tokio::time::interval(Duration::from_millis(500));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        poll_cycle(&api, &rt, Instant::now()).await;
    }
}
async fn poll_cycle(api: &dyn SupportApi, rt: &super::session::Runtime, now: Instant) {
    let plan = {
        let Ok(mut core) = rt.core.lock() else {
            return;
        };
        if core.expire().is_err() {
            let _ = core.end("local_state_unavailable", false);
        }
        let exists = core.session.is_some() || core.code.is_some();
        let active = core.session.as_ref().is_some_and(|s| s.admission.active);
        let due = core.schedule.due(exists, active, now);
        (due, core.epoch)
    };
    if plan.0.session {
        if let Err(code) = fetch_session(api, rt, plan.1).await {
            failure(rt, &code);
        }
    }
    if plan.0.commands {
        if let Err(code) = fetch_commands(api, rt, plan.1).await {
            failure(rt, &code);
        }
    }
}
async fn status_lane(api: &dyn SupportApi, rt: &super::session::Runtime) {
    let mut ticker = tokio::time::interval(SERVER_CHECK_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        status_cycle(api, rt).await;
    }
}
async fn status_cycle(api: &dyn SupportApi, rt: &super::session::Runtime) {
    let epoch = {
        let Ok(core) = rt.core.lock() else {
            return;
        };
        if !core.session.as_ref().is_some_and(|s| s.admission.active) {
            return;
        }
        core.epoch
    };
    if let Err(code) = heartbeat(api, rt, epoch).await {
        failure(rt, &code);
    }
}

fn failure(rt: &super::session::Runtime, code: &str) {
    if let Ok(mut core) = rt.core.lock() {
        core.schedule.failure(Instant::now());
        if let Some(s) = &mut core.session {
            s.admission.online = false;
        }
        if code == "TERMINAL_AUTH_REFUSED" {
            let _ = core.end("terminal_identity_changed", true);
        } else if code == "SESSION_ENDED" {
            let _ = core.end("server_end", false);
        }
    }
}
async fn fetch_session(
    api: &dyn SupportApi,
    rt: &super::session::Runtime,
    epoch: u64,
) -> Result<(), String> {
    let response = api.request("/api/pos/support/session", "GET", None).await?;
    let response: SessionFetch = serde_json::from_value(response).map_err(|_| "INVALID_INPUT")?;
    let id = {
        let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        if core.epoch != epoch {
            if let Some(s) = response.session {
                let now = chrono::Utc::now().timestamp_millis();
                super::session::queue_notice(
                    &core.executor.db,
                    "end",
                    json!({"session_id":s.session_id,"reason":"till_end","ended_at_till":super::clock::iso(now),"write_outcome":null}),
                    now,
                )?;
            }
            return Ok(());
        }
        core.schedule.success();
        match response.state.as_str() {
            "pending_ack" | "active" => {
                let info = response.session.ok_or("INVALID_INPUT")?;
                if core
                    .session
                    .as_ref()
                    .is_none_or(|s| s.info.session_id != info.session_id)
                {
                    if core.code.is_none() {
                        return Err("SESSION_ENDED".into());
                    }
                    core.adopt(info, &response.server_time)?;
                }
                core.session
                    .as_ref()
                    .map(|s| s.info.session_id.clone())
                    .ok_or("SESSION_ENDED")?
            }
            "ended" => {
                core.end(
                    response.end_reason.as_deref().unwrap_or("server_end"),
                    false,
                )?;
                return Ok(());
            }
            "none" => {
                return Ok(());
            }
            "code_pending" => {
                return Ok(());
            }
            _ => return Err("INVALID_INPUT".into()),
        }
    };
    // Missing collector data is explicitly unavailable, never healthy.
    let baseline = tokio::time::timeout(REQUEST_TIMEOUT, api.baseline())
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(|| {
            symptom_baseline(
                Err("unavailable".into()),
                Err("unavailable".into()),
                Err("unavailable".into()),
            )
        });
    let advertisement = {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        // Collectors may yield while the till ends or replaces this session.
        // An ack must never be sent after that local authority is withdrawn.
        if core.epoch != epoch
            || core
                .session
                .as_ref()
                .is_none_or(|s| s.info.session_id != id)
        {
            return Ok(());
        }
        let (capabilities, ids) = core
            .verifier
            .advertisement(&core.executor.db.conn, super::dispatch::capabilities())?;
        let mut body = ack(&id, baseline, capabilities);
        body["pinned_approver_key_ids"] = json!(ids);
        body
    };
    let result = api
        .request("/api/pos/support/session/ack", "POST", Some(advertisement))
        .await?;
    let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
    if core.epoch != epoch {
        return Ok(());
    }
    if result["acknowledged"] != true {
        return Err("INVALID_INPUT".into());
    }
    core.clock
        .observe(
            &id,
            result["server_time"].as_str().ok_or("INVALID_INPUT")?,
            Instant::now(),
        )
        .map_err(str::to_string)?;
    if let Some(s) = &mut core.session {
        s.admission.active = true;
    }
    core.executor.db.conn.execute("UPDATE support_session_state SET status='active' WHERE session_id=?1 AND status='pending_ack'",[id]).map_err(|_|"INTERNAL_ERROR")?;
    core.update_unattended(response.unattended.as_ref())?;
    Ok(())
}
async fn heartbeat(
    api: &dyn SupportApi,
    rt: &super::session::Runtime,
    epoch: u64,
) -> Result<(), String> {
    let body = {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let Some(s) = &core.session else {
            return Ok(());
        };
        let seq: i64 = core
            .executor
            .db
            .conn
            .query_row(
                "SELECT last_seq FROM support_session_state WHERE session_id=?1",
                [&s.info.session_id],
                |r| r.get(0),
            )
            .map_err(|_| "INTERNAL_ERROR")?;
        let activity = core.activity()?;
        let state = if !s.admission.online || !api.visible() {
            "paused"
        } else if super::critical_op::global().active() {
            "deferred"
        } else if activity
            .as_ref()
            .is_some_and(|(_, _, state)| state == "executing")
        {
            "executing"
        } else if activity
            .as_ref()
            .is_some_and(|(_, _, state)| state == "awaiting_onsite")
        {
            "awaiting_onsite"
        } else {
            "connected"
        };
        let mut body = json!({"session_id":s.info.session_id,"state":state,"critical_op_active":super::critical_op::global().active(),"doorbell_healthy":core.schedule.doorbell_healthy,"last_seq":seq});
        if let Some((id, _, _)) = activity.filter(|(_, _, state)| state == "executing") {
            body["executing_command_id"] = json!(id);
        }
        body
    };
    let h: Heartbeat = serde_json::from_value(
        bounded_request(api, "/api/pos/support/heartbeat", "POST", Some(body)).await?,
    )
    .map_err(|_| "INVALID_INPUT")?;
    let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
    if core.epoch == epoch {
        core.apply_heartbeat(h)?;
    }
    Ok(())
}
async fn fetch_commands(
    api: &dyn SupportApi,
    rt: &super::session::Runtime,
    epoch: u64,
) -> Result<(), String> {
    let (id, seq) = {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let Some(s) = &core.session else {
            return Ok(());
        };
        if s.admission.tiers_enabled.is_empty() {
            return Ok(());
        }
        let seq: i64 = core
            .executor
            .db
            .conn
            .query_row(
                "SELECT last_seq FROM support_session_state WHERE session_id=?1",
                [&s.info.session_id],
                |r| r.get(0),
            )
            .map_err(|_| "INTERNAL_ERROR")?;
        (s.info.session_id.clone(), seq)
    };
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("session_id", &id)
        .append_pair("after_seq", &seq.to_string())
        .finish();
    let response = api
        .request(&format!("/api/pos/support/commands?{query}"), "GET", None)
        .await?;
    let commands = response["commands"]
        .as_array()
        .filter(|a| a.len() <= 20)
        .ok_or("INVALID_INPUT")?;
    let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
    if core.epoch != epoch {
        return Ok(());
    }
    core.clock
        .observe(
            &id,
            response["server_time"].as_str().ok_or("INVALID_INPUT")?,
            Instant::now(),
        )
        .map_err(str::to_string)?;
    core.schedule.success();
    let Some(s) = &mut core.session else {
        return Ok(());
    };
    let a = s.admission.clone();
    for value in commands {
        let command = serde_json::from_value(value.clone()).map_err(|_| "INVALID_INPUT")?;
        let super::session::Core {
            executor, clock, ..
        } = &mut *core;
        executor.accept(&command, &a, clock)?;
    }
    Ok(())
}
async fn flush(api: &dyn SupportApi, rt: &super::session::Runtime) -> Result<(), String> {
    // Queued notices and results are the documented exception to idle silence.
    let notices = {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        // Termination delivery always precedes best-effort declines: even a
        // transient failure or old offline decline cannot strand end/cancel.
        let mut stmt = core.executor.db.conn.prepare("SELECT id,kind,body_json FROM support_pending_notices WHERE sent_at IS NULL ORDER BY CASE WHEN kind='consent_decline' THEN 1 ELSE 0 END,created_at,id LIMIT 16").map_err(|_| "INTERNAL_ERROR")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|_| "INTERNAL_ERROR")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| "INTERNAL_ERROR")?;
        rows
    };
    for (id, kind, raw) in notices {
        if kind == "consent_decline" {
            // Best-effort: an unreadable stored decline is retired, and a failed
            // send stops only this notice pass, never result or audit delivery.
            let request = serde_json::from_str::<Value>(&raw)
                .ok()
                .and_then(|notice| consent_decline_request(&notice).ok());
            if let Some((body, staff)) = request {
                match tokio::time::timeout(REQUEST_TIMEOUT, api.consent_decline(body, &staff)).await
                {
                    Ok(Ok(reply)) if parse_consent_decline(reply.clone()).is_ok() => {}
                    Ok(Err(error)) if error.permanent() => {}
                    _ => break,
                }
            }
        } else {
            let body: Value = serde_json::from_str(&raw).map_err(|_| "INTERNAL_ERROR")?;
            let path = if kind == "end" {
                "/api/pos/support/end"
            } else {
                "/api/pos/support/sessions/cancel"
            };
            let result = api.request(path, "POST", Some(body)).await?;
            if result[if kind == "end" { "ended" } else { "cancelled" }]
                .as_bool()
                .is_none()
            {
                return Err("INVALID_INPUT".into());
            }
        }
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        core.executor
            .db
            .conn
            .execute(
                "UPDATE support_pending_notices SET sent_at=?1 WHERE id=?2",
                rusqlite::params![chrono::Utc::now().to_rfc3339(), id],
            )
            .map_err(|_| "INTERNAL_ERROR")?;
    }
    let results = {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        core.executor.pending_results(core.now())?
    };
    for result in results.into_iter().take(3) {
        let response = api
            .request("/api/pos/support/results", "POST", Some(result.clone()))
            .await?;
        if response["stored"] != true {
            return Err("INVALID_INPUT".into());
        }
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        core.executor.delivered(
            result["command_id"].as_str().ok_or("INVALID_INPUT")?,
            result["result_sha256"].as_str().ok_or("INVALID_INPUT")?,
        )?;
    }
    let entries = {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        super::audit_local::pending(&core.executor.db.conn).map_err(|_| "INTERNAL_ERROR")?
    };
    if !entries.is_empty() {
        let response = api
            .request(
                "/api/pos/support/audit",
                "POST",
                Some(json!({"entries":entries})),
            )
            .await?;
        let through = response["accepted_through_seq"]
            .as_i64()
            .ok_or("INVALID_INPUT")?;
        let gaps = response["gaps"]
            .as_array()
            .ok_or("INVALID_INPUT")?
            .iter()
            .map(|v| {
                Ok((
                    v["from"].as_i64().ok_or("INVALID_INPUT")?,
                    v["to"].as_i64().ok_or("INVALID_INPUT")?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        super::audit_local::acknowledge(
            &core.executor.db.conn,
            &entries,
            through,
            &gaps,
            &super::clock::iso(core.now()),
        )
        .map_err(|_| "INTERNAL_ERROR")?;
        super::audit_local::prune(&core.executor.db.conn, core.now())
            .map_err(|_| "INTERNAL_ERROR")?;
    }
    Ok(())
}

/// Read-only access to the real transport lanes for the external test modules.
#[cfg(test)]
pub(super) mod harness {
    use super::*;

    pub async fn session(
        api: &dyn SupportApi,
        rt: &super::super::session::Runtime,
    ) -> Result<(), String> {
        let epoch = rt.core.lock().unwrap().epoch;
        fetch_session(api, rt, epoch).await
    }
    pub async fn status(api: &dyn SupportApi, rt: &super::super::session::Runtime) {
        status_cycle(api, rt).await;
    }
    pub async fn commands(
        api: &dyn SupportApi,
        rt: &super::super::session::Runtime,
    ) -> Result<(), String> {
        let epoch = rt.core.lock().unwrap().epoch;
        fetch_commands(api, rt, epoch).await
    }
    pub async fn deliver(
        api: &dyn SupportApi,
        rt: &super::super::session::Runtime,
    ) -> Result<(), String> {
        flush(api, rt).await
    }
}

#[cfg(test)]
#[path = "tests/transport_loop_tests.rs"]
mod loop_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{atomic::AtomicBool, Arc, Mutex};
    struct MockApi {
        calls: Mutex<Vec<(String, String, Option<Value>)>>,
        replies: Mutex<VecDeque<Value>>,
    }
    impl SupportApi for MockApi {
        fn request<'a>(
            &'a self,
            path: &'a str,
            method: &'a str,
            body: Option<Value>,
        ) -> ApiFuture<'a> {
            self.calls
                .lock()
                .unwrap()
                .push((path.into(), method.into(), body));
            let response = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "TILL_OFFLINE".into());
            Box::pin(async move { response })
        }
        fn visible(&self) -> bool {
            true
        }
    }
    fn response(text: &str) -> Value {
        serde_json::from_str::<Value>(text).unwrap()["response"].clone()
    }
    fn mock(replies: Vec<Value>) -> MockApi {
        MockApi {
            calls: Mutex::new(Vec::new()),
            replies: Mutex::new(replies.into()),
        }
    }
    fn runtime() -> (std::path::PathBuf, Arc<super::super::session::Runtime>) {
        let root = std::env::temp_dir().join(format!("support-api-{}", uuid::Uuid::new_v4()));
        let core =
            super::super::session::Core::new(super::super::db::SupportDb::open(&root).unwrap())
                .unwrap();
        (
            root,
            Arc::new(super::super::session::Runtime {
                core: Mutex::new(core),
                started: AtomicBool::new(false),
                banner_ready: AtomicBool::new(false),
            }),
        )
    }
    #[tokio::test]
    async fn mocked_api_ack_commands_and_audit_follow_the_route_contracts() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = super::super::critical_op::install_test_gate();
        let (root, rt) = runtime();
        rt.core.lock().unwrap().code = Some(super::super::session::CodePending {
            id: "40000000-0000-4000-a000-000000000004".into(),
            expires_at: "2026-11-01T12:10:00.000Z".into(),
        });
        let api = mock(vec![
            response(include_str!(
                "../../../../shared/pos/support/__fixtures__/routes/pos-support-session.json"
            )),
            response(include_str!(
                "../../../../shared/pos/support/__fixtures__/routes/pos-support-session-ack.json"
            )),
            response(include_str!(
                "../../../../shared/pos/support/__fixtures__/routes/pos-support-heartbeat.json"
            )),
            response(include_str!(
                "../../../../shared/pos/support/__fixtures__/routes/pos-support-commands.json"
            )),
            response(include_str!(
                "../../../../shared/pos/support/__fixtures__/routes/pos-support-audit.json"
            )),
        ]);
        fetch_session(&api, &rt, 0).await.unwrap();
        heartbeat(&api, &rt, 0).await.unwrap();
        fetch_commands(&api, &rt, 0).await.unwrap();
        flush(&api, &rt).await.unwrap();
        let calls = api.calls.lock().unwrap();
        assert_eq!(calls.len(), 5);
        assert_eq!(calls[1].0, "/api/pos/support/session/ack");
        assert_eq!(calls[1].2.as_ref().unwrap()["protocol_version"], 1);
        assert!(calls[3].0.ends_with("after_seq=0"));
        assert_eq!(
            calls[4].2.as_ref().unwrap()["entries"][0]["phase"],
            "accepted"
        );
        drop(calls);
        drop(rt);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn idle_transport_is_silent_and_cancelled_fetch_cannot_activate_a_session() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = super::super::critical_op::install_test_gate();
        let (root, rt) = runtime();
        let idle = mock(vec![]);
        flush(&idle, &rt).await.unwrap();
        assert!(idle.calls.lock().unwrap().is_empty());
        let api = mock(vec![response(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-session.json"
        ))]);
        rt.core.lock().unwrap().epoch = 1;
        fetch_session(&api, &rt, 0).await.unwrap();
        let core = rt.core.lock().unwrap();
        assert!(core.session.is_none());
        assert_eq!(
            core.executor
                .db
                .conn
                .query_row("SELECT count(*) FROM support_pending_notices", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(core);
        drop(rt);
        std::fs::remove_dir_all(root).unwrap();
    }
    struct SlowApi;
    impl SupportApi for SlowApi {
        fn request<'a>(&'a self, _: &'a str, _: &'a str, _: Option<Value>) -> ApiFuture<'a> {
            Box::pin(std::future::pending())
        }
        fn visible(&self) -> bool {
            true
        }
    }
    #[tokio::test]
    async fn slow_server_times_out_and_shows_paused_within_the_full_loss_budget() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = super::super::critical_op::install_test_gate();
        let (root, rt) = runtime();
        {
            let mut core = rt.core.lock().unwrap();
            let value = response(include_str!(
                "../../../../shared/pos/support/__fixtures__/routes/pos-support-session.json"
            ));
            core.adopt(
                serde_json::from_value(value["session"].clone()).unwrap(),
                "2026-11-01T12:00:00.000Z",
            )
            .unwrap();
            core.session.as_mut().unwrap().admission.active = true;
        }
        let start = Instant::now();
        status_cycle(&SlowApi, &rt).await;
        assert!(
            start.elapsed() + SERVER_CHECK_INTERVAL + Duration::from_secs(1)
                < Duration::from_secs(10)
        );
        assert_eq!(
            rt.core.lock().unwrap().banner(true).unwrap()["state"],
            "paused"
        );
        drop(rt);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn server_end_on_status_lane_is_applied_without_waiting_for_command_lane() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = super::super::critical_op::install_test_gate();
        let (root, rt) = runtime();
        {
            let mut core = rt.core.lock().unwrap();
            let value = response(include_str!(
                "../../../../shared/pos/support/__fixtures__/routes/pos-support-session.json"
            ));
            core.adopt(
                serde_json::from_value(value["session"].clone()).unwrap(),
                "2026-11-01T12:00:00.000Z",
            )
            .unwrap();
            core.session.as_mut().unwrap().admission.active = true;
        }
        let mut value = response(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-heartbeat.json"
        ));
        value["session_status"] = json!("ended");
        let api = mock(vec![value]);
        let start = Instant::now();
        let (_, ()) = tokio::join!(
            bounded_request(&SlowApi, "/api/pos/support/commands", "GET", None),
            status_cycle(&api, &rt)
        );
        assert!(
            start.elapsed() + SERVER_CHECK_INTERVAL + Duration::from_secs(1)
                < Duration::from_secs(15)
        );
        assert!(rt.core.lock().unwrap().session.is_none());
        drop(rt);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn healthy_doorbell_still_checks_server_before_pause_and_end_deadlines() {
        let at = Instant::now();
        let mut schedule = Schedule::default();
        schedule.doorbell_healthy = true;
        schedule.due(true, true, at);
        assert!(
            schedule
                .due(true, true, at + Duration::from_secs(5))
                .heartbeat
        );
        assert!(
            SERVER_CHECK_INTERVAL + REQUEST_TIMEOUT + Duration::from_secs(1)
                <= Duration::from_secs(10)
        );
    }
    #[test]
    fn baseline_projects_real_collector_fields() {
        let baseline = symptom_baseline(
            Ok(json!({"health_state":"issues","issues":[{"code":"printer.jobs_failed"}]})),
            Ok(json!({"codes":[{"code":"E001","count":2,"first_seen_at":"your_time"}]})),
            Ok(json!({"enabled_modules":[{"id":"restaurant"}]})),
        );
        assert_eq!(
            baseline["health_issue_codes"],
            json!(["printer.jobs_failed"])
        );
        assert_eq!(baseline["error_codes"], json!([{"code":"E001","count":2}]));
        assert_eq!(baseline["module_context"], json!(["restaurant"]));
    }
    #[test]
    fn silence_cadence_doorbell_and_paused_deadline() {
        let at = Instant::now();
        let mut s = Schedule::default();
        assert_eq!(s.due(false, false, at), Due::default());
        assert_eq!(
            s.due(true, true, at),
            Due {
                session: false,
                heartbeat: true,
                commands: true
            }
        );
        assert!(!s.due(true, true, at + Duration::from_secs(2)).commands);
        assert!(s.due(true, true, at + Duration::from_secs(3)).commands);
        s.doorbell_healthy = true;
        assert!(!s.due(true, true, at + Duration::from_secs(6)).commands);
        s.rung = true;
        assert!(s.due(true, true, at + Duration::from_secs(7)).commands);
        assert!(s.due(true, true, at + Duration::from_secs(15)).heartbeat);
        s.failure(at);
        assert!(s.paused(at + Duration::from_secs(10)));
        s.success();
        assert!(!s.paused(at + Duration::from_secs(11)));
    }
    #[test]
    fn consent_transport_binds_the_persisted_session_to_the_request_header() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = super::super::critical_op::install_test_gate();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-consent-accept.json"
        ))
        .unwrap();
        let case = &fixture["cases"][0];
        let staff = json!({"databaseStaffId":case["body"]["staff_id"]});
        crate::storage::session_set(&json!({"staffId":staff["databaseStaffId"],"sessionId":case["headers"]["x-staff-session-id"]}).to_string()).unwrap();
        let (body, header) =
            consent_accept_bound_request(Some(case["body"].clone()), &staff).unwrap();
        let request = reqwest::Client::new()
            .post("https://example.com/api/pos/support/consent/accept")
            .header("x-staff-session-id", &header)
            .json(&body)
            .build()
            .unwrap();
        assert_eq!(
            request.headers()["x-staff-session-id"].to_str().unwrap(),
            case["headers"]["x-staff-session-id"].as_str().unwrap()
        );
        assert_eq!(body, case["body"]);
        let mut other = staff.clone();
        other["databaseStaffId"] = json!("50000000-0000-4000-a000-000000000005");
        assert_eq!(
            consent_accept_bound_request(Some(body), &other).unwrap_err(),
            "POLICY_REFUSED"
        );
    }

    #[test]
    fn support_never_uses_http_or_credentials_in_a_url() {
        for base in [
            "http://localhost",
            "file:///tmp/x",
            "https://user:password@example.com",
            "garbage",
        ] {
            assert!(require_https(base).is_err());
        }
        assert!(require_https("https://example.com").is_ok());
    }
}
