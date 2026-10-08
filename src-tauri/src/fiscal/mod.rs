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
//! Every receipt is queued, whatever the cached `fiscal_active` state (see
//! [`active_cache`]) says: the server answers `skipped` for a branch without
//! a plugin and the row drains. A fresh "no active plugin" answer only keeps
//! queued rows from holding the Z (review of the 29/09/2026 fixes: skipping
//! the enqueue on it dropped a fiscal store's receipts after one
//! `active:false` answer).
//!
//! # Module layout (filled in as Phase 4 tasks land)
//!
//! - `payload_builder` — T18: build a canonical FiscalReceiptInput JSON
//!   value from a locally persisted order, using integer cents (W4).
//! - `dispatcher`      — T19: online POST + offline-enqueue entry point.
//! - `replay`          — T20: process a queued `module_type='fiscal'` row.
//! - `active_cache`    — T21a: 5-minute TTL cache of the branch's fiscal
//!   verdict. A fresh inactive verdict exempts the branch's queued rows from
//!   the Z (close-day guard and closeout drain); it never skips the enqueue.
//! - `status`          — feeds `active_cache` from `GET /api/pos/fiscal/status`
//!   (29/09/2026: nothing wrote the cache before, so it was always unknown).
//! - `currency`        — release-safety check: warns (never fails) when the
//!   branch's active plugin cannot accept the currency its receipts carry.
//! - `greece_vat`      — the order-level Greek VAT (port of the shared
//!   `GreeceOrderVat` contract, the server's `computeOrderTotals`): what
//!   `orders.tax_amount` holds, the fiscal payload lines and the cash
//!   register's per-line rates.
//! - `receipt_vat`     — the VAT a slip prints (port of the shared
//!   `ReceiptVat` contract): computed VAT with an active fiscal plugin or
//!   myDATA device, else the owner's configured rate, else none.
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
pub mod currency;
pub mod dispatcher;
pub mod greece_vat;
pub mod payload_builder;
pub mod receipt_vat;
pub mod replay;
pub mod sequence_counter;
pub mod status;
