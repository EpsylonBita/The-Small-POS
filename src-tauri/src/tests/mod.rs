//! Test-only support modules.
//!
//! Everything in this module tree is gated by `#[cfg(test)]` at the
//! crate root, so production builds contain none of this code.
//!
//! # Why a dedicated module tree?
//!
//! Wave 7 of the review remediation plan (see
//! `D:\The-Small-002\planning\claude\create-a-plan-to-rustling-pretzel.md`)
//! needs parity-gate tests that simulate a process restart and need
//! hermetic isolation from the operator's real OS keyring. The existing
//! inline `#[cfg(test)] mod tests` blocks could not cleanly share
//! `restart_db()` / `FakeKeyring` helpers across files, so we gather
//! the cross-cutting fixtures here.
//!
//! Wave 0 (this commit) only creates the infrastructure. No production
//! test consumes these helpers yet — Wave 7 will add
//! `tests::parity_g7`, `tests::parity_g8`, `tests::parity_g13`, and
//! `tests::parity_g14`.

pub mod fake_http;
pub mod fake_keyring;
pub mod harness;

// Parity gate tests — one module per gate, named after the gate id.
// Each test covers the gate's "no pre-reset state survives" / durability
// / exactly-once invariant described in `pos-tauri/PARITY_GATES.md`.
mod parity_g13;
mod parity_g14;
mod parity_g7;
mod parity_g8;

// W4c — temporary dual-write smoke test. Removed in 4e.
mod w4c_dual_write_smoke;
