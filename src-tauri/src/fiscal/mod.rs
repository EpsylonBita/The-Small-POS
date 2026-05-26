//! Fiscalization integration for pos-tauri.
//!
//! Implements Phase 4 of `.claude/specs/fiscalization-core/tasks.md`
//! (Linear THE-194). The pos-tauri side of the per-country fiscalization
//! plugin platform — receipts persisted locally are dispatched to the
//! admin-dashboard's `/api/plugins/fiscal/submit` endpoint, with an
//! offline fallback onto `parity_sync_queue` keyed by
//! `module_type = 'fiscal'`.
//!
//! # Hard invariant (Req 12 — "fiscalization is optional")
//!
//! The POS order flow MUST never crash because of any fiscal state.
//! Every entry point in this module either returns silently or logs and
//! continues — none of them propagate errors back to the order command.
//! When the local cached `fiscal_active` state (see [`active_cache`]) says
//! "no active plugin", the dispatcher skips even the local enqueue so the
//! offline outbox doesn't fill with payloads that will only ever resolve
//! to `status='skipped'` once replayed.
//!
//! # Module layout (filled in as Phase 4 tasks land)
//!
//! - `payload_builder` — T18: build a canonical FiscalReceiptInput JSON
//!   value from a locally persisted order, using integer cents (W4).
//! - `dispatcher`      — T19: online POST + offline-enqueue entry point.
//! - `replay`          — T20: process a queued `module_type='fiscal'` row.
//! - `active_cache`    — T21a: 5-minute TTL cache of the last successful
//!   `/api/plugins/fiscal/health` poll. Short-circuits the offline enqueue.
//! - `close_day_guard` — T23: z-report close refuses to complete while
//!   any fiscal row is `pending`/`processing` for the business day under
//!   a currently active plugin (stale-plugin rows are auto-marked
//!   `blocked` and do NOT block close — Req 4.7a).
//!
//! Each submodule is declared with `pub mod` AS IT IS SHIPPED, not
//! upfront — declaring a `pub mod foo;` for a missing file breaks
//! compilation. Per-task `pub mod` lines are added by T18 / T19 / T20 /
//! T21a / T23.

pub mod active_cache;
pub mod close_day_guard;
pub mod dispatcher;
pub mod payload_builder;
pub mod replay;
pub mod sequence_counter;
