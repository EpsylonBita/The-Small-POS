//! Caller ID module types.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CallerIdMode {
    AuthenticatedSip,
    PbxIpTrustLegacy,
}

impl Default for CallerIdMode {
    fn default() -> Self {
        Self::AuthenticatedSip
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CallerIdTransport {
    Udp,
    Tcp,
}

impl Default for CallerIdTransport {
    fn default() -> Self {
        Self::Udp
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CallerIdStatusReason {
    AuthFailed,
    Timeout,
    UnsupportedProvider,
    PortInUse,
    InvalidConfig,
    NetworkError,
    Unknown,
}

/// SIP listener configuration stored in `local_settings` (category `callerid`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdConfig {
    #[serde(default)]
    pub mode: CallerIdMode,
    #[serde(default)]
    pub transport: CallerIdTransport,
    /// SIP server IP or hostname (e.g. "192.168.1.1")
    pub sip_server: String,
    /// SIP server port (default 5060)
    #[serde(default = "default_sip_port")]
    pub sip_port: u16,
    /// SIP username / extension (e.g. "200")
    pub sip_username: String,
    /// Optional auth username when different from SIP extension
    pub auth_username: Option<String>,
    /// Optional outbound proxy override in host[:port] form
    pub outbound_proxy: Option<String>,
    /// Provider or PBX preset used by the guided setup UI
    pub provider_preset_id: Option<String>,
    /// Local UDP port to listen on for incoming INVITE (default 5060)
    #[serde(default = "default_listen_port")]
    pub listen_port: u16,
    /// Whether the listener is enabled
    #[serde(default)]
    pub enabled: bool,
    /// Whether a SIP password exists in secure local storage. Read-only to frontend.
    #[serde(default)]
    pub has_password: bool,
}

fn default_sip_port() -> u16 {
    5060
}

fn default_listen_port() -> u16 {
    5060
}

impl Default for CallerIdConfig {
    fn default() -> Self {
        Self {
            mode: CallerIdMode::AuthenticatedSip,
            transport: CallerIdTransport::Udp,
            sip_server: String::new(),
            sip_port: default_sip_port(),
            sip_username: String::new(),
            auth_username: None,
            outbound_proxy: None,
            provider_preset_id: None,
            listen_port: default_listen_port(),
            enabled: false,
            has_password: false,
        }
    }
}

impl CallerIdConfig {
    pub fn effective_auth_username(&self) -> &str {
        self.auth_username
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(self.sip_username.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedCallerIdConfig {
    pub config: CallerIdConfig,
    pub sip_password: Option<String>,
}

/// An incoming call event emitted to the frontend and broadcast to other terminals.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingCallEvent {
    /// Phone number extracted from SIP INVITE From: header
    pub caller_number: String,
    /// Display name from SIP From: header (may be empty)
    pub caller_name: Option<String>,
    /// SIP Call-ID header (used for deduplication)
    pub sip_call_id: String,
    /// ISO 8601 timestamp of detection
    pub timestamp: String,
}

/// Status of the SIP listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListenerStatus {
    /// Not started / stopped
    Stopped,
    /// Currently listening for SIP INVITE messages
    Listening,
    /// Registration sent, waiting for 200 OK
    Registering,
    /// An error occurred (check logs)
    Error,
}

/// Status response for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdStatus {
    pub status: ListenerStatus,
    pub error: Option<String>,
    pub reason: Option<CallerIdStatusReason>,
    pub registered: bool,
    pub calls_detected: u64,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let cfg = CallerIdConfig::default();
        assert_eq!(cfg.sip_port, 5060);
        assert_eq!(cfg.listen_port, 5060);
        assert!(!cfg.enabled);
        assert!(cfg.sip_server.is_empty());
        assert_eq!(cfg.mode, CallerIdMode::AuthenticatedSip);
        assert_eq!(cfg.transport, CallerIdTransport::Udp);
        assert!(!cfg.has_password);
    }

    #[test]
    fn test_config_serialization_roundtrip() {
        let cfg = CallerIdConfig {
            mode: CallerIdMode::PbxIpTrustLegacy,
            transport: CallerIdTransport::Tcp,
            sip_server: "192.168.1.1".into(),
            sip_port: 5060,
            sip_username: "200".into(),
            auth_username: Some("auth200".into()),
            outbound_proxy: Some("proxy.example.com:5080".into()),
            provider_preset_id: Some("generic_sip".into()),
            listen_port: 5062,
            enabled: true,
            has_password: true,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let deserialized: CallerIdConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.sip_server, "192.168.1.1");
        assert_eq!(deserialized.listen_port, 5062);
        assert!(deserialized.enabled);
        assert_eq!(deserialized.mode, CallerIdMode::PbxIpTrustLegacy);
        assert_eq!(deserialized.transport, CallerIdTransport::Tcp);
        assert_eq!(deserialized.auth_username.as_deref(), Some("auth200"));
        assert!(deserialized.has_password);
    }

    #[test]
    fn test_incoming_call_event_serialization() {
        let evt = IncomingCallEvent {
            caller_number: "+306912345678".into(),
            caller_name: Some("John".into()),
            sip_call_id: "abc123@192.168.1.1".into(),
            timestamp: "2026-03-25T12:00:00Z".into(),
        };
        let json = serde_json::to_string(&evt).unwrap();
        assert!(json.contains("callerNumber"));
        assert!(json.contains("+306912345678"));
    }

    #[test]
    fn test_listener_status_serialization() {
        let status = ListenerStatus::Listening;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"listening\"");
    }

    #[test]
    fn test_effective_auth_username_defaults_to_sip_username() {
        let cfg = CallerIdConfig {
            sip_username: "200".into(),
            ..Default::default()
        };
        assert_eq!(cfg.effective_auth_username(), "200");

        let cfg = CallerIdConfig {
            sip_username: "200".into(),
            auth_username: Some("auth200".into()),
            ..Default::default()
        };
        assert_eq!(cfg.effective_auth_username(), "auth200");
    }
}
