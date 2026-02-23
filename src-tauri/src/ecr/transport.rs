//! Transport layer for ECR device communication.
//!
//! Defines the `EcrTransport` trait and concrete implementations for serial
//! (COM/RS-232), network (TCP), and Bluetooth connections.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use tracing::{debug, info, warn};

// ---------------------------------------------------------------------------
// Transport state
// ---------------------------------------------------------------------------

/// Connection state for transport layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportState {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

// ---------------------------------------------------------------------------
// Transport trait
// ---------------------------------------------------------------------------

/// Abstract byte-level transport for ECR devices.
pub trait EcrTransport: Send {
    /// Establish the connection.
    fn connect(&mut self) -> Result<(), String>;

    /// Tear down the connection.
    fn disconnect(&mut self) -> Result<(), String>;

    /// Send raw bytes. Returns number of bytes written.
    fn send(&mut self, data: &[u8]) -> Result<usize, String>;

    /// Receive bytes with a timeout (ms). Returns bytes read.
    fn receive(&mut self, timeout_ms: u64) -> Result<Vec<u8>, String>;

    /// Convenience: send then receive in one step.
    fn send_and_receive(&mut self, data: &[u8], timeout_ms: u64) -> Result<Vec<u8>, String> {
        self.send(data)?;
        self.receive(timeout_ms)
    }

    /// Whether the transport is currently connected.
    fn is_connected(&self) -> bool;

    /// Current transport state.
    fn state(&self) -> TransportState;

    /// Human-readable description of the connection target.
    fn description(&self) -> String;
}

// ---------------------------------------------------------------------------
// Serial transport
// ---------------------------------------------------------------------------

/// Serial (COM / RS-232 / USB-serial) transport using the `serialport` crate.
pub struct SerialTransport {
    port_name: String,
    baud_rate: u32,
    timeout_ms: u64,
    port: Option<Box<dyn serialport::SerialPort>>,
    state: TransportState,
}

impl SerialTransport {
    pub fn new(port_name: &str, baud_rate: u32, timeout_ms: u64) -> Self {
        Self {
            port_name: port_name.to_string(),
            baud_rate,
            timeout_ms,
            port: None,
            state: TransportState::Disconnected,
        }
    }
}

impl EcrTransport for SerialTransport {
    fn connect(&mut self) -> Result<(), String> {
        self.state = TransportState::Connecting;
        info!(
            "Opening serial port {} @ {} baud",
            self.port_name, self.baud_rate
        );

        let port = serialport::new(&self.port_name, self.baud_rate)
            .timeout(Duration::from_millis(self.timeout_ms))
            .open()
            .map_err(|e| {
                self.state = TransportState::Error;
                format!("Failed to open {}: {e}", self.port_name)
            })?;

        self.port = Some(port);
        self.state = TransportState::Connected;
        info!("Serial port {} connected", self.port_name);
        Ok(())
    }

    fn disconnect(&mut self) -> Result<(), String> {
        self.port = None;
        self.state = TransportState::Disconnected;
        info!("Serial port {} disconnected", self.port_name);
        Ok(())
    }

    fn send(&mut self, data: &[u8]) -> Result<usize, String> {
        let port = self.port.as_mut().ok_or("Serial port not connected")?;
        debug!("Serial TX ({} bytes): {:02X?}", data.len(), data);
        let n = port
            .write(data)
            .map_err(|e| format!("Serial write error: {e}"))?;
        port.flush()
            .map_err(|e| format!("Serial flush error: {e}"))?;
        Ok(n)
    }

    fn receive(&mut self, timeout_ms: u64) -> Result<Vec<u8>, String> {
        let port = self.port.as_mut().ok_or("Serial port not connected")?;

        // Set read timeout for this call
        port.set_timeout(Duration::from_millis(timeout_ms))
            .map_err(|e| format!("Set timeout: {e}"))?;

        let mut buf = vec![0u8; 4096];
        match port.read(&mut buf) {
            Ok(n) => {
                buf.truncate(n);
                debug!("Serial RX ({n} bytes): {:02X?}", &buf);
                Ok(buf)
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                debug!("Serial RX timeout after {timeout_ms}ms");
                Ok(Vec::new())
            }
            Err(e) => {
                self.state = TransportState::Error;
                Err(format!("Serial read error: {e}"))
            }
        }
    }

    fn is_connected(&self) -> bool {
        self.state == TransportState::Connected && self.port.is_some()
    }

    fn state(&self) -> TransportState {
        self.state
    }

    fn description(&self) -> String {
        format!("Serial({}@{})", self.port_name, self.baud_rate)
    }
}

// ---------------------------------------------------------------------------
// Network (TCP) transport
// ---------------------------------------------------------------------------

/// TCP network transport for ECR devices accessible over LAN/WAN.
pub struct NetworkTransport {
    host: String,
    port: u16,
    connect_timeout_ms: u64,
    stream: Option<TcpStream>,
    state: TransportState,
}

impl NetworkTransport {
    pub fn new(host: &str, port: u16, connect_timeout_ms: u64) -> Self {
        Self {
            host: host.to_string(),
            port,
            connect_timeout_ms,
            stream: None,
            state: TransportState::Disconnected,
        }
    }
}

impl EcrTransport for NetworkTransport {
    fn connect(&mut self) -> Result<(), String> {
        self.state = TransportState::Connecting;
        info!("Connecting TCP to {}:{}", self.host, self.port);

        let addr = format!("{}:{}", self.host, self.port);
        let stream = TcpStream::connect_timeout(
            &addr
                .parse()
                .map_err(|e| format!("Invalid address {addr}: {e}"))?,
            Duration::from_millis(self.connect_timeout_ms),
        )
        .map_err(|e| {
            self.state = TransportState::Error;
            format!("TCP connect to {addr} failed: {e}")
        })?;

        // Set default read/write timeouts
        let _ = stream.set_read_timeout(Some(Duration::from_millis(5000)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(5000)));
        let _ = stream.set_nodelay(true);

        self.stream = Some(stream);
        self.state = TransportState::Connected;
        info!("TCP connected to {}:{}", self.host, self.port);
        Ok(())
    }

    fn disconnect(&mut self) -> Result<(), String> {
        if let Some(ref stream) = self.stream {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        self.stream = None;
        self.state = TransportState::Disconnected;
        info!("TCP disconnected from {}:{}", self.host, self.port);
        Ok(())
    }

    fn send(&mut self, data: &[u8]) -> Result<usize, String> {
        let stream = self.stream.as_mut().ok_or("TCP not connected")?;
        debug!("TCP TX ({} bytes): {:02X?}", data.len(), data);
        let n = stream.write(data).map_err(|e| format!("TCP write: {e}"))?;
        stream.flush().map_err(|e| format!("TCP flush: {e}"))?;
        Ok(n)
    }

    fn receive(&mut self, timeout_ms: u64) -> Result<Vec<u8>, String> {
        let stream = self.stream.as_mut().ok_or("TCP not connected")?;

        stream
            .set_read_timeout(Some(Duration::from_millis(timeout_ms)))
            .map_err(|e| format!("Set read timeout: {e}"))?;

        let mut buf = vec![0u8; 4096];
        match stream.read(&mut buf) {
            Ok(0) => {
                warn!("TCP connection closed by peer");
                self.state = TransportState::Error;
                Err("Connection closed by peer".into())
            }
            Ok(n) => {
                buf.truncate(n);
                debug!("TCP RX ({n} bytes): {:02X?}", &buf);
                Ok(buf)
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                debug!("TCP RX timeout after {timeout_ms}ms");
                Ok(Vec::new())
            }
            Err(e) => {
                self.state = TransportState::Error;
                Err(format!("TCP read: {e}"))
            }
        }
    }

    fn is_connected(&self) -> bool {
        self.state == TransportState::Connected && self.stream.is_some()
    }

    fn state(&self) -> TransportState {
        self.state
    }

    fn description(&self) -> String {
        format!("TCP({}:{})", self.host, self.port)
    }
}

// ---------------------------------------------------------------------------
// Bluetooth transport (placeholder)
// ---------------------------------------------------------------------------

/// Bluetooth RFCOMM transport — placeholder for future implementation.
///
/// Bluetooth serial communication on Windows requires platform-specific APIs
/// (e.g. `winrt-bluetooth` or `btleplug` crate). This placeholder returns
/// clear errors while the infrastructure is wired up.
pub struct BluetoothTransport {
    address: String,
    #[allow(dead_code)]
    channel: u8,
    state: TransportState,
}

impl BluetoothTransport {
    pub fn new(address: &str, channel: u8) -> Self {
        Self {
            address: address.to_string(),
            channel,
            state: TransportState::Disconnected,
        }
    }
}

impl EcrTransport for BluetoothTransport {
    fn connect(&mut self) -> Result<(), String> {
        Err(format!(
            "Bluetooth transport not yet implemented (device: {}). Use Serial or Network connection instead.",
            self.address
        ))
    }

    fn disconnect(&mut self) -> Result<(), String> {
        self.state = TransportState::Disconnected;
        Ok(())
    }

    fn send(&mut self, _data: &[u8]) -> Result<usize, String> {
        Err("Bluetooth transport not yet implemented".into())
    }

    fn receive(&mut self, _timeout_ms: u64) -> Result<Vec<u8>, String> {
        Err("Bluetooth transport not yet implemented".into())
    }

    fn is_connected(&self) -> bool {
        false
    }

    fn state(&self) -> TransportState {
        self.state
    }

    fn description(&self) -> String {
        format!("Bluetooth({})", self.address)
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/// Create a transport from connection type and details JSON.
pub fn create_transport(
    connection_type: &str,
    details: &serde_json::Value,
) -> Result<Box<dyn EcrTransport>, String> {
    match connection_type {
        "serial_usb" | "usb" => {
            let port = details
                .get("port")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'port' in connection details")?;
            let baud = details
                .get("baudRate")
                .and_then(|v| v.as_u64())
                .unwrap_or(9600) as u32;
            let timeout = details
                .get("timeoutMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(3000);
            Ok(Box::new(SerialTransport::new(port, baud, timeout)))
        }
        "network" => {
            let host = details
                .get("ip")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'ip' in connection details")?;
            let port = details.get("port").and_then(|v| v.as_u64()).unwrap_or(9100) as u16;
            let timeout = details
                .get("connectTimeoutMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(5000);
            Ok(Box::new(NetworkTransport::new(host, port, timeout)))
        }
        "bluetooth" => {
            let addr = details
                .get("address")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'address' in connection details")?;
            let channel = details.get("channel").and_then(|v| v.as_u64()).unwrap_or(1) as u8;
            Ok(Box::new(BluetoothTransport::new(addr, channel)))
        }
        other => Err(format!("Unknown connection type: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serial_transport_state_initial() {
        let t = SerialTransport::new("COM99", 9600, 3000);
        assert_eq!(t.state(), TransportState::Disconnected);
        assert!(!t.is_connected());
        assert_eq!(t.description(), "Serial(COM99@9600)");
    }

    #[test]
    fn test_network_transport_state_initial() {
        let t = NetworkTransport::new("192.168.1.100", 20007, 5000);
        assert_eq!(t.state(), TransportState::Disconnected);
        assert!(!t.is_connected());
        assert_eq!(t.description(), "TCP(192.168.1.100:20007)");
    }

    #[test]
    fn test_bluetooth_transport_connect_returns_error() {
        let mut t = BluetoothTransport::new("AA:BB:CC:DD:EE:FF", 1);
        assert!(t.connect().is_err());
        assert!(!t.is_connected());
    }

    #[test]
    fn test_create_transport_serial() {
        let details = serde_json::json!({"port": "COM3", "baudRate": 19200});
        let t = create_transport("serial_usb", &details).unwrap();
        assert_eq!(t.description(), "Serial(COM3@19200)");
    }

    #[test]
    fn test_create_transport_network() {
        let details = serde_json::json!({"ip": "10.0.0.1", "port": 4000});
        let t = create_transport("network", &details).unwrap();
        assert_eq!(t.description(), "TCP(10.0.0.1:4000)");
    }

    #[test]
    fn test_create_transport_unknown() {
        let details = serde_json::json!({});
        assert!(create_transport("unknown", &details).is_err());
    }

    #[test]
    fn test_serial_send_without_connect_errors() {
        let mut t = SerialTransport::new("COM99", 9600, 3000);
        assert!(t.send(b"test").is_err());
    }

    #[test]
    fn test_network_send_without_connect_errors() {
        let mut t = NetworkTransport::new("127.0.0.1", 9999, 1000);
        assert!(t.send(b"test").is_err());
    }
}
