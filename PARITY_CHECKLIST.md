# POS Tauri Parity Checklist

## Purpose

Track high-level migration parity status for the native-only `pos-tauri` runtime.

This checklist is intentionally concise and operational. The old exhaustive migration inventory is archived for historical reference.

## Last Updated

- Date: 2026-02-23
- Owner: POS desktop migration/security stream

## Current Status

| Area | Status | Notes |
|---|---|---|
| Desktop runtime cutover | COMPLETE | Native-only (`tauri|browser`) runtime; no Electron desktop surface in `pos-tauri` |
| Typed bridge migration | COMPLETE | Renderer command/event paths use `ipc-adapter` and `event-bridge` |
| Core POS workflows | COMPLETE | Auth, orders, shifts, payments, menu, print, diagnostics, updates |
| Offline-first sync behavior | COMPLETE | Queue-first local writes; offline deferral; reconnect catch-up |
| Security hardening P0/P1 | COMPLETE | Implemented and documented in migration backlog |
| Automated parity/security gates | COMPLETE | `parity:contract`, `test:native-runtime`, type/build/rust checks passing |
| 24h staging soak evidence | IN PROGRESS | Final operational sign-off pending |

## Active Validation Checklist

- [x] `npm run type-check`
- [x] `npm run build`
- [x] `npm run parity:contract`
- [x] `npm run test:native-runtime`
- [x] `cargo check --keep-going --manifest-path src-tauri/Cargo.toml`
- [ ] Execute 24-hour staging soak and produce signed report artifact

## Remaining Sign-Off Work

1. Run `node scripts/tauri-smoke.mjs --report docs/security-native-migration/reports/staging-soak-report.json` on staging terminal.
2. Validate report with `npm run soak:report`.
3. Attach soak report + log/admin evidence to migration sign-off PR.

## Historical Reference

- Archived exhaustive checklist snapshot: `docs/archive/parity/PARITY_CHECKLIST_2026-02-14.md`
- Active gate definitions: `PARITY_GATES.md`
- Migration execution ledger: `docs/security-native-migration/EXECUTION_BACKLOG.md`
