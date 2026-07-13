# POS Tauri Documentation Index

## Purpose

This folder and top-level markdown files document the current native-only `pos-tauri` runtime, its security posture, release process, and migration history.

## Current Source-Of-Truth Documents

- `../README.md`: entry point, quickstart, verification commands, and document map.
- `../ARCHITECTURE.md`: runtime topology, bridge/event contracts, offline sync model, security boundaries.
- `../RELEASE.md`: packaging, signing, updater manifest, and release automation.
- `../SUPPORT.md`: diagnostics workflow and incident playbooks.
- `../PARITY_GATES.md`: active parity gate definitions and execution model.
- `../PARITY_CHECKLIST.md`: active parity status tracker.
- `offline-store-schema-and-migrations.md`: current Tauri SQLite schema, queue ownership, API mapping, conflict expectations, and installed-terminal migration risks.
- `offline-sync-telemetry-qa.md`: manual QA checklist for offline replay telemetry, reconnect behavior, and secret-safe diagnostics evidence.
- `receipt-printing-2026.md`: receipt template system, queue payload snapshots, width/charset behavior, and print fallbacks.
- `gap-review-2026-07-10.md`: open defect ledger from the 2026-07-10 full-surface review — 93 adversarially-verified findings (6 P0, 28 P1, 40 P2, 19 P3) plus 6 refuted, each with per-finding file/line, evidence, and suggested fix.

## Security/Native Migration Set

- `security-native-migration/README.md`: migration artifacts index and refresh process.
- `security-native-migration/AUDIT_REPORT.md`: audit findings with evidence.
- `security-native-migration/FILE_MATRIX.csv`: per-file triage matrix.
- `security-native-migration/NATIVE_MIGRATION_RFC.md`: target architecture contracts.
- `security-native-migration/EXECUTION_BACKLOG.md`: implementation ledger and pending actions.
- `security-native-migration/SECURITY_VERIFICATION_PACK.md`: regression scenarios and sign-off checklist.
- `security-native-migration/STAGING_SOAK_RUNBOOK.md`: 24-hour pilot run procedure.

## Historical/Archive Material

- `archive/parity/PARITY_CHECKLIST_2026-02-14.md`: original full migration checklist snapshot.
- `archive/parity/PARITY_GATES_LEGACY_2026-02-16.md`: legacy detailed gate definitions.
- `../PHASE2_NOTES.md`, `../PHASE4_NOTES.md`, `../PHASE8_COMPLETE.md`, `../PHASE8_SUMMARY.md`: phase history records.

## Update Rules

1. Update `README.md` and `ARCHITECTURE.md` first when runtime architecture changes.
2. Update migration/security artifacts in the same PR as implementation changes.
3. Treat `archive/` content as immutable snapshots; create new snapshot files instead of editing existing ones.
4. Keep command examples aligned with `package.json` scripts.
