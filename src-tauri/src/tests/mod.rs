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

// Raw-body admin transport (`admin_fetch_raw`) — invoice capture, D11/R17.4.
mod capture_transport;

// Repair transport identity, bounded response, and raw-upload contracts.
mod repair_transport;
mod repairs;

// Parity gate tests — one module per gate, named after the gate id.
// Each test covers the gate's "no pre-reset state survives" / durability
// / exactly-once invariant described in `pos-tauri/PARITY_GATES.md`.
mod parity_g13;
mod parity_g14;
mod parity_g7;
mod parity_g8;

// W4c — temporary dual-write smoke test. Removed in 4e.
mod w4c_dual_write_smoke;

// B1 (fix review 30/09/2026): payments set aside for review, end to end.
mod payment_set_aside;

// Fix review 30/09/2026: card payments charged but not saved, end to end.
mod unsaved_payments;

// Merge of #308 (30/09/2026): one card approval, one payment, across the
// direct-SALE admission and the set-aside / not-saved payment records.
mod direct_sale_payment_records;

// Item C (fix review 30/09/2026): a courier's cash comes only from payment rows.
mod driver_cash_from_payment_rows;

// Item E (fix review 30/09/2026): a card charged at new-order checkout that
// the till could not save, end to end.
mod unsaved_checkout;

// Item F (fix review 30/09/2026): "Record cash" / "Record card" on a payment
// blocker needs the money approval, is audited and keyed once.
mod record_payment_blocker;

// Item G (fix review 30/09/2026): the till's order numbers never restart
// after a failed or unparsable counter read.
mod order_number_counter;

// Item H (fix review 30/09/2026): a read error of the store's money settings
// is not "missing".
mod money_settings;

// Item D3 (fix review 30/09/2026): Assign Driver applies the payment record
// path's guard: no courier cash for money a delivery platform holds.
mod driver_platform_held;

// Item D2 (fix review 30/09/2026): the pull respects the server payment's
// status: a payment voided or refunded there never stays completed here.
mod remote_payment_status;

// Item D1 (fix review 30/09/2026): cancelling an order that still owes money
// needs a reason and the money approval, and is audited.
mod order_cancel_approval;

// Fix review 30/09/2026: every cancel refuses an order money was taken on.
mod cancel_money_taken;

// Fix review 30/09/2026: a slow card terminal is never paid twice.
mod checkout_double_charge;

// Fix review 30/09/2026: with nobody on shift, a manager approves the Z's
// money actions with their own PIN.
mod manager_approval_no_shift;

// Round 2 of the 01/10/2026 fix review: 1.4.119 placeholder payment rows
// count nowhere and ask the server's ledger once.
mod placeholder_payments;

// Item D8 (01/10/2026): Ready on a platform order the till is behind on
// writes nothing and never settles a cancelled order.
mod platform_ready;

// Round 3 of the 01/10/2026 fix review: a platform settlement row never
// refuses a cancel, and a folio charge is its own record (shared R1, R6).
mod round3_settlement_and_folio;

// Round 3: a server deletion keeps paid and closed-Z orders, hidden (R7).
mod round3_server_deletions;

// Round 3: a refund names its tender, never cash for an `other` one (R5).
mod round3_refund_tender;

// Round 3: platform-held money is never recorded at the till (R4).
mod round3_platform_held;

// Round 3 item DR5: a failing set-aside restore never blocks the rest.
mod round3_set_aside_restore;

// Round 3 review fixes: the settlement row is never reversed at the till and
// one classifier in both apps (R1); the platform-held set-aside and the
// shared store-collectable contract (R4); an `other` refund names it (R5).
mod round3_review_fixes;
