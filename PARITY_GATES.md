# POS Tauri Parity Gates

This document defines the active parity gate set for `pos-tauri` after native-only cutover.

## Gate Status Legend

- `PASS`: validated and accepted.
- `PASS (local)`: passed in local/manual verification; still requires staging soak confirmation.
- `PENDING`: not yet validated for release sign-off.

## Automated Contract Gates (2026-02-22)

| Gate | Description | Validation command | Status |
|---|---|---|---|
| A1 | Type safety and frontend build integrity | `npm run type-check && npm run build` | PASS |
| A2 | Renderer invoke/event parity contract | `npm run parity:contract` | PASS |
| A3 | Native-only runtime guardrails (no Electron surfaces) | `npm run test:native-runtime` | PASS |
| A4 | Rust backend compile integrity | `cargo check --keep-going --manifest-path src-tauri/Cargo.toml` | PASS |

## Manual Functional Gates

| Gate | Description | Primary outcome | Status |
|---|---|---|---|
| G1 | Offline order creation + restart persistence | Orders stay pending and recover after restart | PASS (local) |
| G2 | Sync idempotency (no duplicates) | Repeated sync does not duplicate orders | PASS (local) |
| G3 | Menu cache stability | Cached menu survives restart/offline windows | PASS (local) |
| G4 | Auth lockout behavior | Failed PIN attempts lock and recover by policy | PASS (local) |
| G5 | Shift lifecycle integrity | Open/close flow and variance remain correct | PASS (local) |
| G6 | Shift offline persistence + exactly-once sync | Offline shift events queue and sync once on reconnect | PASS (local) |
| G8 | Payment offline persistence + exactly-once sync | Payment queue behavior remains durable/idempotent | PASS (local) |
| G9 | Deferred payment reconciliation | Parent/child sync ordering resolves deferred states correctly | PASS (local) |
| G10 | Print pipeline offline safety + idempotency | Receipt job durability and duplicate suppression hold | PASS (local) |
| G11 | Hardware print resilience | Print failures do not corrupt payment/order state | PASS (local) |
| G12 | Cash drawer resilience | Drawer errors remain non-blocking and rate-limited | PASS (local) |
| G13 | Refund/void offline persistence + exactly-once sync | Financial adjustments persist and reconcile correctly | PASS (local) |
| G14 | End-of-day close + z-report offline behavior | Shift close and z-report remain durable offline | PASS (local) |

## Outstanding Release Gate

| Gate | Description | Evidence required | Status |
|---|---|---|---|
| S1 | 24-hour staging soak (forced offline/online toggles) | `staging-soak-report.json` + log/admin evidence per runbook | PENDING |

## How To Execute Gates

### 1) Automated checks

```bash
npm run type-check
npm run build
npm run parity:contract
npm run test:native-runtime
cargo check --keep-going --manifest-path src-tauri/Cargo.toml
```

### 2) Manual gate run + report export

```bash
node scripts/tauri-smoke.mjs --report docs/security-native-migration/reports/staging-soak-report.json
npm run soak:report
```

## Source of Truth and Archives

- Active manual gate runner: `scripts/tauri-smoke.mjs`
- Staging soak procedure: `docs/security-native-migration/STAGING_SOAK_RUNBOOK.md`
- Legacy detailed gate document (pre-reorganization): `docs/archive/parity/PARITY_GATES_LEGACY_2026-02-16.md`
