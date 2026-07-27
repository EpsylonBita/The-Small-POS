//! Caller ID / VoIP module.
//!
//! Phase 1 uses only the private per-line Caller ID v2 Realtime path. The
//! legacy SIP parser/listener source remains on disk for data compatibility
//! history, but it is deliberately absent from the compiled module graph.

pub mod manager;
pub mod types;

pub use manager::CallerIdManager;
