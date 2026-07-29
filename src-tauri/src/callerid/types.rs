//! Caller ID module types.

use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CallerIdMode {
    #[default]
    AuthenticatedSip,
    PbxIpTrustLegacy,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CallerIdTransport {
    #[default]
    Udp,
    Tcp,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CallerIdConnectorFamily {
    AnalogFxo,
    SipPbx,
    CloudWebhook,
    AnalogUsb,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdSourceConfig {
    pub source_id: Uuid,
    pub source_version: u32,
    pub device_profile_key: String,
    pub connector_family: CallerIdConnectorFamily,
    pub line_id: Uuid,
    pub source_channel: String,
    pub trusted_device_ip: IpAddr,
    pub listen_port: u16,
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
    use std::net::{IpAddr, Ipv4Addr};
    use uuid::Uuid;

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
    fn test_listener_status_serialization() {
        let status = ListenerStatus::Listening;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"listening\"");
    }

    #[test]
    fn source_config_preserves_the_server_issued_source_and_channel_identity() {
        let config: CallerIdSourceConfig = serde_json::from_value(serde_json::json!({
            "sourceId": "018f7684-1436-7d3d-a3f8-58b1bf600da0",
            "sourceVersion": 7,
            "deviceProfileKey": "grandstream_ht841_fxo",
            "connectorFamily": "analog_fxo",
            "lineId": "018f7684-1436-7d3d-a3f8-58b1bf600dbd",
            "sourceChannel": "fxo-3",
            "trustedDeviceIp": "192.168.1.70",
            "listenPort": 5062
        }))
        .expect("server-issued FXO source config");

        assert_eq!(
            config.source_id,
            Uuid::parse_str("018f7684-1436-7d3d-a3f8-58b1bf600da0").unwrap()
        );
        assert_eq!(config.source_version, 7);
        assert_eq!(config.device_profile_key, "grandstream_ht841_fxo");
        assert_eq!(config.connector_family, CallerIdConnectorFamily::AnalogFxo);
        assert_eq!(
            config.line_id,
            Uuid::parse_str("018f7684-1436-7d3d-a3f8-58b1bf600dbd").unwrap()
        );
        assert_eq!(config.source_channel, "fxo-3");
        assert_eq!(
            config.trusted_device_ip,
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 70))
        );
        assert_eq!(config.listen_port, 5062);
    }
}
