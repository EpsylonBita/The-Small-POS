//! Background SIP listener and registration workflow.

use std::collections::HashMap;
use std::net::UdpSocket as StdUdpSocket;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde_json::Value;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use super::manager::CallerIdManager;
use super::sip_parser::{
    self, build_digest_authorization, build_register_request, parse_digest_challenge,
    parse_sip_invite, RegisterRequestParams, SipDigestChallenge,
};
use super::types::{
    CallerIdMode, CallerIdStatusReason, CallerIdTransport, IncomingCallEvent,
    ResolvedCallerIdConfig,
};

const REGISTER_INTERVAL_SECS: u64 = 300;
const MAX_SIP_PACKET: usize = 8192;
const RESPONSE_TIMEOUT_SECS: u64 = 5;
const RECENT_CALL_TTL_SECS: u64 = 30;

pub fn start_sip_listener(
    resolved: ResolvedCallerIdConfig,
    manager: Arc<CallerIdManager>,
    app_handle: tauri::AppHandle,
    cancel: CancellationToken,
) {
    let listener_cancel = cancel.child_token();
    manager.set_task_cancel(listener_cancel.clone());

    tokio::spawn(async move {
        let result = match resolved.config.transport {
            CallerIdTransport::Udp => {
                run_udp_listener(
                    resolved,
                    Arc::clone(&manager),
                    app_handle.clone(),
                    listener_cancel,
                )
                .await
            }
            CallerIdTransport::Tcp => {
                run_tcp_listener(
                    resolved,
                    Arc::clone(&manager),
                    app_handle.clone(),
                    listener_cancel,
                )
                .await
            }
        };

        if let Err((reason, message)) = result {
            error!(reason = ?reason, error = %message, "Caller ID listener stopped with error");
            manager.set_error(message.clone(), reason);
            emit_status(&app_handle, "error", false, Some(message), Some(reason));
        }
    });
}

pub async fn test_sip_connection(
    resolved: &ResolvedCallerIdConfig,
) -> Result<(), (CallerIdStatusReason, String)> {
    match resolved.config.transport {
        CallerIdTransport::Udp => test_udp_connection(resolved).await,
        CallerIdTransport::Tcp => test_tcp_connection(resolved).await,
    }
}

async fn run_udp_listener(
    resolved: ResolvedCallerIdConfig,
    manager: Arc<CallerIdManager>,
    app_handle: tauri::AppHandle,
    cancel: CancellationToken,
) -> Result<(), (CallerIdStatusReason, String)> {
    info!(
        mode = ?resolved.config.mode,
        transport = ?resolved.config.transport,
        server = %resolved.config.sip_server,
        port = resolved.config.sip_port,
        listen_port = resolved.config.listen_port,
        "Starting UDP Caller ID listener"
    );

    let bind_addr = format!("0.0.0.0:{}", resolved.config.listen_port);
    let socket = UdpSocket::bind(&bind_addr).await.map_err(|error| {
        (
            CallerIdStatusReason::PortInUse,
            format!("Failed to bind UDP socket on {bind_addr}: {error}"),
        )
    })?;

    let local_ip = detect_local_ip(&resolved);
    let register_call_id = format!("pos-reg-{}@{local_ip}", uuid::Uuid::new_v4());
    let mut cseq: u32 = 1;
    let mut register_interval = tokio::time::interval(Duration::from_secs(REGISTER_INTERVAL_SECS));
    register_interval.tick().await;
    let mut buf = vec![0u8; MAX_SIP_PACKET];
    let mut recent_calls = HashMap::new();

    register_once_udp(
        &socket,
        &resolved,
        &manager,
        &app_handle,
        &local_ip,
        &register_call_id,
        &mut cseq,
        &mut recent_calls,
    )
    .await?;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                info!("UDP Caller ID listener cancelled");
                let dereg_cseq = next_cseq(&mut cseq);
                let dereg = build_register_request(&RegisterRequestParams {
                    server: &resolved.config.sip_server,
                    port: resolved.config.sip_port,
                    transport: CallerIdTransport::Udp,
                    username: &resolved.config.sip_username,
                    contact_host: &local_ip,
                    contact_port: resolved.config.listen_port,
                    call_id: &register_call_id,
                    cseq: dereg_cseq,
                    expires: 0,
                    authorization_header: None,
                });
                let _ = socket.send_to(&dereg, resolve_target(&resolved).as_str()).await;
                manager.stop();
                emit_status(&app_handle, "stopped", false, None, None);
                return Ok(());
            }
            _ = register_interval.tick() => {
                if let Err((reason, message)) = register_once_udp(
                    &socket,
                    &resolved,
                    &manager,
                    &app_handle,
                    &local_ip,
                    &register_call_id,
                    &mut cseq,
                    &mut recent_calls,
                ).await {
                    manager.set_error(message.clone(), reason);
                    emit_status(&app_handle, "error", false, Some(message.clone()), Some(reason));
                    if matches!(reason, CallerIdStatusReason::AuthFailed | CallerIdStatusReason::UnsupportedProvider) {
                        return Err((reason, message));
                    }
                }
            }
            result = socket.recv_from(&mut buf) => {
                match result {
                    Ok((len, from_addr)) => {
                        process_sip_message(
                            &buf[..len],
                            &app_handle,
                            &manager,
                            &mut recent_calls,
                        ).await;

                        if sip_parser::is_register_ok(&buf[..len]) {
                            info!("SIP REGISTER accepted by {from_addr}");
                            manager.set_registered(true);
                            emit_status(&app_handle, "listening", true, None, None);
                        }
                    }
                    Err(error) => {
                        warn!(error = %error, "UDP Caller ID recv error");
                    }
                }
            }
        }
    }
}

async fn run_tcp_listener(
    resolved: ResolvedCallerIdConfig,
    manager: Arc<CallerIdManager>,
    app_handle: tauri::AppHandle,
    cancel: CancellationToken,
) -> Result<(), (CallerIdStatusReason, String)> {
    info!(
        mode = ?resolved.config.mode,
        transport = ?resolved.config.transport,
        server = %resolved.config.sip_server,
        port = resolved.config.sip_port,
        "Starting TCP Caller ID listener"
    );

    let mut session = TcpSipSession::connect(&resolved).await?;
    let local_ip = detect_local_ip(&resolved);
    let register_call_id = format!("pos-reg-{}@{local_ip}", uuid::Uuid::new_v4());
    let mut cseq: u32 = 1;
    let mut register_interval = tokio::time::interval(Duration::from_secs(REGISTER_INTERVAL_SECS));
    register_interval.tick().await;
    let mut recent_calls = HashMap::new();

    register_once_tcp(
        &mut session,
        &resolved,
        &manager,
        &app_handle,
        &local_ip,
        &register_call_id,
        &mut cseq,
        &mut recent_calls,
    )
    .await?;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                info!("TCP Caller ID listener cancelled");
                let dereg_cseq = next_cseq(&mut cseq);
                let local_port = session.local_port().unwrap_or(resolved.config.listen_port);
                let dereg = build_register_request(&RegisterRequestParams {
                    server: &resolved.config.sip_server,
                    port: resolved.config.sip_port,
                    transport: CallerIdTransport::Tcp,
                    username: &resolved.config.sip_username,
                    contact_host: &local_ip,
                    contact_port: local_port,
                    call_id: &register_call_id,
                    cseq: dereg_cseq,
                    expires: 0,
                    authorization_header: None,
                });
                let _ = session.send(&dereg).await;
                manager.stop();
                emit_status(&app_handle, "stopped", false, None, None);
                return Ok(());
            }
            _ = register_interval.tick() => {
                if let Err((reason, message)) = register_once_tcp(
                    &mut session,
                    &resolved,
                    &manager,
                    &app_handle,
                    &local_ip,
                    &register_call_id,
                    &mut cseq,
                    &mut recent_calls,
                ).await {
                    manager.set_error(message.clone(), reason);
                    emit_status(&app_handle, "error", false, Some(message.clone()), Some(reason));
                    if matches!(reason, CallerIdStatusReason::AuthFailed | CallerIdStatusReason::UnsupportedProvider) {
                        return Err((reason, message));
                    }
                }
            }
            message = session.recv_message() => {
                match message {
                    Ok(data) => {
                        process_sip_message(
                            &data,
                            &app_handle,
                            &manager,
                            &mut recent_calls,
                        ).await;
                    }
                    Err(error) => {
                        return Err((
                            CallerIdStatusReason::NetworkError,
                            format!("TCP SIP connection closed: {error}"),
                        ));
                    }
                }
            }
        }
    }
}

async fn register_once_udp(
    socket: &UdpSocket,
    resolved: &ResolvedCallerIdConfig,
    manager: &Arc<CallerIdManager>,
    app_handle: &tauri::AppHandle,
    local_ip: &str,
    call_id: &str,
    cseq: &mut u32,
    recent_calls: &mut HashMap<String, Instant>,
) -> Result<(), (CallerIdStatusReason, String)> {
    manager.set_registering();
    emit_status(app_handle, "registering", false, None, None);

    let request_cseq = next_cseq(cseq);
    let request = build_register_request(&RegisterRequestParams {
        server: &resolved.config.sip_server,
        port: resolved.config.sip_port,
        transport: CallerIdTransport::Udp,
        username: &resolved.config.sip_username,
        contact_host: local_ip,
        contact_port: resolved.config.listen_port,
        call_id,
        cseq: request_cseq,
        expires: REGISTER_INTERVAL_SECS as u32 + 30,
        authorization_header: None,
    });
    socket
        .send_to(&request, resolve_target(resolved).as_str())
        .await
        .map_err(|error| {
            (
                CallerIdStatusReason::NetworkError,
                format!("Failed to send SIP REGISTER: {error}"),
            )
        })?;

    wait_for_register_response_udp(
        socket,
        resolved,
        manager,
        app_handle,
        local_ip,
        call_id,
        cseq,
        recent_calls,
    )
    .await
}

async fn register_once_tcp(
    session: &mut TcpSipSession,
    resolved: &ResolvedCallerIdConfig,
    manager: &Arc<CallerIdManager>,
    app_handle: &tauri::AppHandle,
    local_ip: &str,
    call_id: &str,
    cseq: &mut u32,
    recent_calls: &mut HashMap<String, Instant>,
) -> Result<(), (CallerIdStatusReason, String)> {
    manager.set_registering();
    emit_status(app_handle, "registering", false, None, None);

    let request_cseq = next_cseq(cseq);
    let local_port = session.local_port().unwrap_or(resolved.config.listen_port);
    let request = build_register_request(&RegisterRequestParams {
        server: &resolved.config.sip_server,
        port: resolved.config.sip_port,
        transport: CallerIdTransport::Tcp,
        username: &resolved.config.sip_username,
        contact_host: local_ip,
        contact_port: local_port,
        call_id,
        cseq: request_cseq,
        expires: REGISTER_INTERVAL_SECS as u32 + 30,
        authorization_header: None,
    });
    session.send(&request).await?;

    wait_for_register_response_tcp(
        session,
        resolved,
        manager,
        app_handle,
        local_ip,
        call_id,
        cseq,
        recent_calls,
    )
    .await
}

async fn wait_for_register_response_udp(
    socket: &UdpSocket,
    resolved: &ResolvedCallerIdConfig,
    manager: &Arc<CallerIdManager>,
    app_handle: &tauri::AppHandle,
    local_ip: &str,
    call_id: &str,
    cseq: &mut u32,
    recent_calls: &mut HashMap<String, Instant>,
) -> Result<(), (CallerIdStatusReason, String)> {
    let mut buf = vec![0u8; MAX_SIP_PACKET];
    let result = timeout(Duration::from_secs(RESPONSE_TIMEOUT_SECS), async {
        loop {
            let (len, _) = socket.recv_from(&mut buf).await.map_err(|error| {
                (
                    CallerIdStatusReason::NetworkError,
                    format!("Failed to receive SIP response: {error}"),
                )
            })?;

            if let Some(invite) = parse_sip_invite(&buf[..len]) {
                handle_call_event(invite, app_handle, manager, recent_calls).await;
                continue;
            }

            if sip_parser::is_register_ok(&buf[..len]) {
                manager.set_registered(true);
                emit_status(app_handle, "listening", true, None, None);
                return Ok(());
            }

            if sip_parser::is_auth_challenge(&buf[..len]) {
                handle_auth_challenge_udp(&buf[..len], socket, resolved, local_ip, call_id, cseq)
                    .await?;
                manager.set_registered(true);
                emit_status(app_handle, "listening", true, None, None);
                return Ok(());
            }
        }
    })
    .await;

    match result {
        Ok(inner) => inner,
        Err(_) => Err((
            CallerIdStatusReason::Timeout,
            "SIP registration timed out — check server, credentials, and firewall".into(),
        )),
    }
}

async fn wait_for_register_response_tcp(
    session: &mut TcpSipSession,
    resolved: &ResolvedCallerIdConfig,
    manager: &Arc<CallerIdManager>,
    app_handle: &tauri::AppHandle,
    local_ip: &str,
    call_id: &str,
    cseq: &mut u32,
    recent_calls: &mut HashMap<String, Instant>,
) -> Result<(), (CallerIdStatusReason, String)> {
    let result = timeout(Duration::from_secs(RESPONSE_TIMEOUT_SECS), async {
        loop {
            let data = session.recv_message().await.map_err(|error| {
                (
                    CallerIdStatusReason::NetworkError,
                    format!("Failed to receive SIP response: {error}"),
                )
            })?;

            if let Some(invite) = parse_sip_invite(&data) {
                handle_call_event(invite, app_handle, manager, recent_calls).await;
                continue;
            }

            if sip_parser::is_register_ok(&data) {
                manager.set_registered(true);
                emit_status(app_handle, "listening", true, None, None);
                return Ok(());
            }

            if sip_parser::is_auth_challenge(&data) {
                handle_auth_challenge_tcp(&data, session, resolved, local_ip, call_id, cseq)
                    .await?;
                manager.set_registered(true);
                emit_status(app_handle, "listening", true, None, None);
                return Ok(());
            }
        }
    })
    .await;

    match result {
        Ok(inner) => inner,
        Err(_) => Err((
            CallerIdStatusReason::Timeout,
            "SIP registration timed out — check server, credentials, and firewall".into(),
        )),
    }
}

async fn handle_auth_challenge_udp(
    response: &[u8],
    socket: &UdpSocket,
    resolved: &ResolvedCallerIdConfig,
    local_ip: &str,
    call_id: &str,
    cseq: &mut u32,
) -> Result<(), (CallerIdStatusReason, String)> {
    if matches!(resolved.config.mode, CallerIdMode::PbxIpTrustLegacy) {
        return Err((
            CallerIdStatusReason::AuthFailed,
            "SIP server requires authentication. Use the authenticated SIP setup mode.".into(),
        ));
    }

    let password = resolved.sip_password.as_deref().ok_or((
        CallerIdStatusReason::InvalidConfig,
        "A SIP password is required for authenticated SIP".into(),
    ))?;

    let challenge = parse_digest_challenge(response).ok_or((
        CallerIdStatusReason::UnsupportedProvider,
        "SIP server returned an unsupported authentication challenge".into(),
    ))?;
    let auth_request = build_authenticated_register(
        &challenge,
        resolved,
        password,
        local_ip,
        resolved.config.listen_port,
        call_id,
        next_cseq(cseq),
    )?;
    socket
        .send_to(&auth_request, resolve_target(resolved).as_str())
        .await
        .map_err(|error| {
            (
                CallerIdStatusReason::NetworkError,
                format!("Failed to send authenticated SIP REGISTER: {error}"),
            )
        })?;

    let mut buf = vec![0u8; MAX_SIP_PACKET];
    match timeout(
        Duration::from_secs(RESPONSE_TIMEOUT_SECS),
        socket.recv_from(&mut buf),
    )
    .await
    {
        Ok(Ok((len, _))) if sip_parser::is_register_ok(&buf[..len]) => Ok(()),
        Ok(Ok(_)) => Err((
            CallerIdStatusReason::AuthFailed,
            "SIP server rejected the supplied credentials".into(),
        )),
        Ok(Err(error)) => Err((
            CallerIdStatusReason::NetworkError,
            format!("Failed to receive SIP response: {error}"),
        )),
        Err(_) => Err((
            CallerIdStatusReason::Timeout,
            "Authenticated SIP registration timed out".into(),
        )),
    }
}

async fn handle_auth_challenge_tcp(
    response: &[u8],
    session: &mut TcpSipSession,
    resolved: &ResolvedCallerIdConfig,
    local_ip: &str,
    call_id: &str,
    cseq: &mut u32,
) -> Result<(), (CallerIdStatusReason, String)> {
    if matches!(resolved.config.mode, CallerIdMode::PbxIpTrustLegacy) {
        return Err((
            CallerIdStatusReason::AuthFailed,
            "SIP server requires authentication. Use the authenticated SIP setup mode.".into(),
        ));
    }

    let password = resolved.sip_password.as_deref().ok_or((
        CallerIdStatusReason::InvalidConfig,
        "A SIP password is required for authenticated SIP".into(),
    ))?;

    let challenge = parse_digest_challenge(response).ok_or((
        CallerIdStatusReason::UnsupportedProvider,
        "SIP server returned an unsupported authentication challenge".into(),
    ))?;
    let local_port = session.local_port().unwrap_or(resolved.config.listen_port);
    let auth_request = build_authenticated_register(
        &challenge,
        resolved,
        password,
        local_ip,
        local_port,
        call_id,
        next_cseq(cseq),
    )?;
    session.send(&auth_request).await?;

    match timeout(
        Duration::from_secs(RESPONSE_TIMEOUT_SECS),
        session.recv_message(),
    )
    .await
    {
        Ok(Ok(data)) if sip_parser::is_register_ok(&data) => Ok(()),
        Ok(Ok(_)) => Err((
            CallerIdStatusReason::AuthFailed,
            "SIP server rejected the supplied credentials".into(),
        )),
        Ok(Err(error)) => Err((
            CallerIdStatusReason::NetworkError,
            format!("Failed to receive SIP response: {error}"),
        )),
        Err(_) => Err((
            CallerIdStatusReason::Timeout,
            "Authenticated SIP registration timed out".into(),
        )),
    }
}

fn build_authenticated_register(
    challenge: &SipDigestChallenge,
    resolved: &ResolvedCallerIdConfig,
    password: &str,
    local_ip: &str,
    local_port: u16,
    call_id: &str,
    cseq: u32,
) -> Result<Vec<u8>, (CallerIdStatusReason, String)> {
    let uri = format!(
        "sip:{}:{}",
        resolved.config.sip_server, resolved.config.sip_port
    );
    let cnonce = uuid::Uuid::new_v4().simple().to_string();
    let authorization = build_digest_authorization(
        challenge,
        resolved.config.effective_auth_username(),
        password,
        "REGISTER",
        &uri,
        &cnonce,
        1,
    )
    .ok_or((
        CallerIdStatusReason::UnsupportedProvider,
        "SIP server requires an unsupported authentication algorithm".into(),
    ))?;

    Ok(build_register_request(&RegisterRequestParams {
        server: &resolved.config.sip_server,
        port: resolved.config.sip_port,
        transport: resolved.config.transport,
        username: &resolved.config.sip_username,
        contact_host: local_ip,
        contact_port: local_port,
        call_id,
        cseq,
        expires: REGISTER_INTERVAL_SECS as u32 + 30,
        authorization_header: Some(&authorization),
    }))
}

async fn process_sip_message(
    data: &[u8],
    app_handle: &tauri::AppHandle,
    manager: &Arc<CallerIdManager>,
    recent_calls: &mut HashMap<String, Instant>,
) {
    if let Some(invite) = parse_sip_invite(data) {
        handle_call_event(invite, app_handle, manager, recent_calls).await;
    }
}

async fn handle_call_event(
    invite: super::sip_parser::SipInviteInfo,
    app_handle: &tauri::AppHandle,
    manager: &Arc<CallerIdManager>,
    recent_calls: &mut HashMap<String, Instant>,
) {
    prune_recent_calls(recent_calls);

    if recent_calls.contains_key(&invite.call_id) {
        return;
    }
    recent_calls.insert(invite.call_id.clone(), Instant::now());
    manager.increment_calls();

    let event = IncomingCallEvent {
        caller_number: invite.caller_number,
        caller_name: invite.caller_name,
        sip_call_id: invite.call_id,
        timestamp: Utc::now().to_rfc3339(),
    };
    let base_payload = serde_json::json!({
        "callerNumber": event.caller_number,
        "callerName": event.caller_name,
        "customer": Value::Null,
        "sipCallId": event.sip_call_id,
        "timestamp": event.timestamp,
    });

    let _ = app_handle.emit("callerid:incoming-call", base_payload.clone());
    record_caller_log(
        app_handle,
        base_payload["callerNumber"].as_str().unwrap_or_default(),
        base_payload["callerName"].as_str(),
        None,
        None,
        base_payload["sipCallId"].as_str().unwrap_or_default(),
        "detected",
    );

    match broadcast_to_admin(app_handle, &base_payload).await {
        Ok(customer) => {
            let customer_payload = customer.unwrap_or(Value::Null);
            let payload = serde_json::json!({
                "callerNumber": base_payload["callerNumber"].as_str().unwrap_or_default(),
                "callerName": base_payload["callerName"].as_str(),
                "customer": customer_payload,
                "sipCallId": base_payload["sipCallId"].as_str().unwrap_or_default(),
                "timestamp": base_payload["timestamp"].as_str().unwrap_or_default(),
            });
            let _ = app_handle.emit("callerid:incoming-call", payload.clone());
            record_caller_log(
                app_handle,
                payload["callerNumber"].as_str().unwrap_or_default(),
                payload["callerName"].as_str(),
                payload["customer"].get("id").and_then(Value::as_str),
                payload["customer"].get("name").and_then(Value::as_str),
                payload["sipCallId"].as_str().unwrap_or_default(),
                "broadcasted",
            );
        }
        Err(error) => {
            warn!(error = %error, "Caller ID broadcast to admin failed");
            record_caller_log(
                app_handle,
                base_payload["callerNumber"].as_str().unwrap_or_default(),
                base_payload["callerName"].as_str(),
                None,
                None,
                base_payload["sipCallId"].as_str().unwrap_or_default(),
                "broadcast_failed",
            );
        }
    }
}

fn prune_recent_calls(recent_calls: &mut HashMap<String, Instant>) {
    let cutoff = Duration::from_secs(RECENT_CALL_TTL_SECS);
    recent_calls.retain(|_, seen_at| seen_at.elapsed() <= cutoff);
}

fn next_cseq(cseq: &mut u32) -> u32 {
    let current = *cseq;
    *cseq = cseq.saturating_add(1);
    current
}

fn detect_local_ip(resolved: &ResolvedCallerIdConfig) -> String {
    let target = resolve_target(resolved);
    match StdUdpSocket::bind("0.0.0.0:0") {
        Ok(socket) => {
            if socket.connect(&target).is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    return addr.ip().to_string();
                }
            }
            "127.0.0.1".into()
        }
        Err(_) => "127.0.0.1".into(),
    }
}

fn resolve_target(resolved: &ResolvedCallerIdConfig) -> String {
    let host = resolved
        .config
        .outbound_proxy
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(resolved.config.sip_server.as_str())
        .trim();

    if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:{}", resolved.config.sip_port)
    }
}

fn emit_status(
    app_handle: &tauri::AppHandle,
    status: &str,
    registered: bool,
    error: Option<String>,
    reason: Option<CallerIdStatusReason>,
) {
    let _ = app_handle.emit(
        "callerid:status",
        serde_json::json!({
            "status": status,
            "registered": registered,
            "error": error,
            "reason": reason,
        }),
    );
}

fn record_caller_log(
    app_handle: &tauri::AppHandle,
    caller_number: &str,
    caller_name: Option<&str>,
    customer_id: Option<&str>,
    customer_name: Option<&str>,
    sip_call_id: &str,
    action_taken: &str,
) {
    let db_state = app_handle.state::<crate::db::DbState>();
    let Ok(conn) = db_state.conn.lock() else {
        warn!("Failed to acquire DB lock for caller_id_log");
        return;
    };
    if let Err(error) = crate::db::upsert_caller_id_log(
        &conn,
        caller_number,
        caller_name,
        customer_id,
        customer_name,
        sip_call_id,
        action_taken,
    ) {
        warn!(error = %error, "Failed to persist caller_id_log row");
    }
}

async fn broadcast_to_admin(
    _app_handle: &tauri::AppHandle,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let response = crate::admin_fetch(
        None,
        "/api/pos/caller-id/event",
        "POST",
        Some(payload.clone()),
    )
    .await?;

    Ok(response.get("customer").cloned())
}

async fn test_udp_connection(
    resolved: &ResolvedCallerIdConfig,
) -> Result<(), (CallerIdStatusReason, String)> {
    let bind_addr = format!("0.0.0.0:{}", resolved.config.listen_port);
    let socket = UdpSocket::bind(&bind_addr).await.map_err(|error| {
        (
            CallerIdStatusReason::PortInUse,
            format!("Failed to bind UDP socket on {bind_addr}: {error}"),
        )
    })?;

    let local_ip = detect_local_ip(resolved);
    let call_id = format!("pos-test-{}@{local_ip}", uuid::Uuid::new_v4());
    let request = build_register_request(&RegisterRequestParams {
        server: &resolved.config.sip_server,
        port: resolved.config.sip_port,
        transport: CallerIdTransport::Udp,
        username: &resolved.config.sip_username,
        contact_host: &local_ip,
        contact_port: resolved.config.listen_port,
        call_id: &call_id,
        cseq: 1,
        expires: 60,
        authorization_header: None,
    });
    socket
        .send_to(&request, resolve_target(resolved).as_str())
        .await
        .map_err(|error| {
            (
                CallerIdStatusReason::NetworkError,
                format!("Failed to send SIP REGISTER: {error}"),
            )
        })?;

    let mut buf = vec![0u8; MAX_SIP_PACKET];
    let result = timeout(Duration::from_secs(RESPONSE_TIMEOUT_SECS), async {
        loop {
            let (len, _) = socket.recv_from(&mut buf).await.map_err(|error| {
                (
                    CallerIdStatusReason::NetworkError,
                    format!("Failed to receive SIP response: {error}"),
                )
            })?;
            let data = &buf[..len];

            if parse_sip_invite(data).is_some() {
                continue;
            }
            if sip_parser::is_register_ok(data) {
                return Ok(());
            }
            if sip_parser::is_auth_challenge(data) {
                return retry_authenticated_udp(data, &socket, resolved, &local_ip, &call_id).await;
            }
        }
    })
    .await;

    match result {
        Ok(inner) => inner,
        Err(_) => Err((
            CallerIdStatusReason::Timeout,
            "SIP registration timed out — check server, credentials, and firewall".into(),
        )),
    }
}

async fn retry_authenticated_udp(
    response: &[u8],
    socket: &UdpSocket,
    resolved: &ResolvedCallerIdConfig,
    local_ip: &str,
    call_id: &str,
) -> Result<(), (CallerIdStatusReason, String)> {
    if matches!(resolved.config.mode, CallerIdMode::PbxIpTrustLegacy) {
        return Err((
            CallerIdStatusReason::AuthFailed,
            "SIP server requires authentication. Use the authenticated SIP setup mode.".into(),
        ));
    }

    let password = resolved.sip_password.as_deref().ok_or((
        CallerIdStatusReason::InvalidConfig,
        "A SIP password is required for authenticated SIP".into(),
    ))?;
    let challenge = parse_digest_challenge(response).ok_or((
        CallerIdStatusReason::UnsupportedProvider,
        "SIP server returned an unsupported authentication challenge".into(),
    ))?;
    let request = build_authenticated_register(
        &challenge,
        resolved,
        password,
        local_ip,
        resolved.config.listen_port,
        call_id,
        2,
    )?;
    socket
        .send_to(&request, resolve_target(resolved).as_str())
        .await
        .map_err(|error| {
            (
                CallerIdStatusReason::NetworkError,
                format!("Failed to send authenticated SIP REGISTER: {error}"),
            )
        })?;

    let mut buf = vec![0u8; MAX_SIP_PACKET];
    match timeout(
        Duration::from_secs(RESPONSE_TIMEOUT_SECS),
        socket.recv_from(&mut buf),
    )
    .await
    {
        Ok(Ok((len, _))) if sip_parser::is_register_ok(&buf[..len]) => Ok(()),
        Ok(Ok(_)) => Err((
            CallerIdStatusReason::AuthFailed,
            "SIP server rejected the supplied credentials".into(),
        )),
        Ok(Err(error)) => Err((
            CallerIdStatusReason::NetworkError,
            format!("Failed to receive SIP response: {error}"),
        )),
        Err(_) => Err((
            CallerIdStatusReason::Timeout,
            "Authenticated SIP registration timed out".into(),
        )),
    }
}

async fn test_tcp_connection(
    resolved: &ResolvedCallerIdConfig,
) -> Result<(), (CallerIdStatusReason, String)> {
    let mut session = TcpSipSession::connect(resolved).await?;
    let local_ip = detect_local_ip(resolved);
    let local_port = session.local_port().unwrap_or(resolved.config.listen_port);
    let call_id = format!("pos-test-{}@{local_ip}", uuid::Uuid::new_v4());
    let request = build_register_request(&RegisterRequestParams {
        server: &resolved.config.sip_server,
        port: resolved.config.sip_port,
        transport: CallerIdTransport::Tcp,
        username: &resolved.config.sip_username,
        contact_host: &local_ip,
        contact_port: local_port,
        call_id: &call_id,
        cseq: 1,
        expires: 60,
        authorization_header: None,
    });
    session.send(&request).await?;

    let result = timeout(Duration::from_secs(RESPONSE_TIMEOUT_SECS), async {
        loop {
            let data = session.recv_message().await.map_err(|error| {
                (
                    CallerIdStatusReason::NetworkError,
                    format!("Failed to receive SIP response: {error}"),
                )
            })?;

            if parse_sip_invite(&data).is_some() {
                continue;
            }
            if sip_parser::is_register_ok(&data) {
                return Ok(());
            }
            if sip_parser::is_auth_challenge(&data) {
                return retry_authenticated_tcp(&data, &mut session, resolved, &local_ip, &call_id)
                    .await;
            }
        }
    })
    .await;

    match result {
        Ok(inner) => inner,
        Err(_) => Err((
            CallerIdStatusReason::Timeout,
            "SIP registration timed out — check server, credentials, and firewall".into(),
        )),
    }
}

async fn retry_authenticated_tcp(
    response: &[u8],
    session: &mut TcpSipSession,
    resolved: &ResolvedCallerIdConfig,
    local_ip: &str,
    call_id: &str,
) -> Result<(), (CallerIdStatusReason, String)> {
    if matches!(resolved.config.mode, CallerIdMode::PbxIpTrustLegacy) {
        return Err((
            CallerIdStatusReason::AuthFailed,
            "SIP server requires authentication. Use the authenticated SIP setup mode.".into(),
        ));
    }

    let password = resolved.sip_password.as_deref().ok_or((
        CallerIdStatusReason::InvalidConfig,
        "A SIP password is required for authenticated SIP".into(),
    ))?;
    let challenge = parse_digest_challenge(response).ok_or((
        CallerIdStatusReason::UnsupportedProvider,
        "SIP server returned an unsupported authentication challenge".into(),
    ))?;
    let local_port = session.local_port().unwrap_or(resolved.config.listen_port);
    let request = build_authenticated_register(
        &challenge, resolved, password, local_ip, local_port, call_id, 2,
    )?;
    session.send(&request).await?;

    match timeout(
        Duration::from_secs(RESPONSE_TIMEOUT_SECS),
        session.recv_message(),
    )
    .await
    {
        Ok(Ok(data)) if sip_parser::is_register_ok(&data) => Ok(()),
        Ok(Ok(_)) => Err((
            CallerIdStatusReason::AuthFailed,
            "SIP server rejected the supplied credentials".into(),
        )),
        Ok(Err(error)) => Err((
            CallerIdStatusReason::NetworkError,
            format!("Failed to receive SIP response: {error}"),
        )),
        Err(_) => Err((
            CallerIdStatusReason::Timeout,
            "Authenticated SIP registration timed out".into(),
        )),
    }
}

struct TcpSipSession {
    stream: TcpStream,
    read_buffer: Vec<u8>,
}

impl TcpSipSession {
    async fn connect(
        resolved: &ResolvedCallerIdConfig,
    ) -> Result<Self, (CallerIdStatusReason, String)> {
        let target = resolve_target(resolved);
        let stream = TcpStream::connect(&target).await.map_err(|error| {
            (
                CallerIdStatusReason::NetworkError,
                format!("Failed to connect to SIP server {target}: {error}"),
            )
        })?;

        Ok(Self {
            stream,
            read_buffer: Vec::with_capacity(MAX_SIP_PACKET),
        })
    }

    fn local_port(&self) -> Option<u16> {
        self.stream.local_addr().ok().map(|addr| addr.port())
    }

    async fn send(&mut self, data: &[u8]) -> Result<(), (CallerIdStatusReason, String)> {
        self.stream.write_all(data).await.map_err(|error| {
            (
                CallerIdStatusReason::NetworkError,
                format!("Failed to send TCP SIP message: {error}"),
            )
        })
    }

    async fn recv_message(&mut self) -> Result<Vec<u8>, String> {
        loop {
            if let Some(message) = extract_sip_message(&mut self.read_buffer) {
                return Ok(message);
            }

            let mut chunk = vec![0u8; MAX_SIP_PACKET];
            let bytes_read = self
                .stream
                .read(&mut chunk)
                .await
                .map_err(|error| format!("Failed to read from TCP SIP stream: {error}"))?;

            if bytes_read == 0 {
                return Err("TCP SIP stream closed by remote peer".into());
            }

            self.read_buffer.extend_from_slice(&chunk[..bytes_read]);
        }
    }
}

fn extract_sip_message(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let headers_end = buffer.windows(4).position(|window| window == b"\r\n\r\n")?;
    let message_end = headers_end + 4 + sip_parser::content_length(&buffer[..headers_end + 4]);

    if buffer.len() < message_end {
        return None;
    }

    let remaining = buffer.split_off(message_end);
    let message = std::mem::replace(buffer, remaining);
    Some(message)
}
