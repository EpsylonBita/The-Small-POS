//! Caller ID / VoIP module.
//!
//! The hardened Grandstream FXO source listens only for direct event-only UDP
//! INVITEs from exact server-provisioned private addresses. Receiving terminals
//! continue to use the private per-line Caller ID v2 Realtime path.

pub mod activation;
pub mod grandstream_fxo;
pub mod invite_policy;
pub mod manager;
pub mod types;
mod whozz;

pub use manager::CallerIdManager;
