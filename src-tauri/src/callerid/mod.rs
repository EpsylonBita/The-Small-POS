//! Caller ID / VoIP module.
//!
//! Provides SIP-based caller ID recognition for VoIP phone lines. When a
//! phone rings, the POS terminal detects the caller's number via SIP INVITE
//! parsing and shows a notification popup with customer lookup.
//!
//! Architecture mirrors the ECR module pattern:
//! - `types.rs`        — Config, event, and status types
//! - `sip_parser.rs`   — Manual SIP message parser (~250 LOC, no external SIP crate)
//! - `sip_listener.rs` — Background UDP listener (tokio::spawn + CancellationToken)
//! - `manager.rs`      — CallerIdManager singleton (Mutex + Tauri managed state)

pub mod manager;
pub mod sip_listener;
pub mod sip_parser;
pub mod types;

pub use manager::CallerIdManager;
