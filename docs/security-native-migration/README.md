# POS Tauri Security + Native Migration Artifacts

## Overview

This directory contains the formal audit/remediation artifacts for the `pos-tauri` security hardening and native runtime migration program.

These files are used for:

- security sign-off,
- migration traceability,
- rollout validation,
- and regression-proof documentation.

## Current Status (2026-02-23)

- P0/P1 hardening items are implemented in the runtime codebase.
- Native-only desktop cutover is implemented.
- Remaining operational sign-off item is the 24-hour staging soak run and report approval.

## Artifacts

| File | Purpose | When to update |
|---|---|---|
| `AUDIT_REPORT.md` | Risk findings summary with evidence and remediation state | When new findings are discovered or risk status changes |
| `FILE_MATRIX.csv` | Exhaustive per-file classification/risk matrix | When files are added/removed or triage outcomes change |
| `NATIVE_MIGRATION_RFC.md` | Target architecture, contracts, deprecation decisions | When runtime interface contracts change |
| `EXECUTION_BACKLOG.md` | Implementation ledger and pending actions | Every implementation milestone |
| `SECURITY_VERIFICATION_PACK.md` | Regression/security scenarios and expected outcomes | When tests or controls change |
| `STAGING_SOAK_RUNBOOK.md` | Procedure for staged 24h offline/online soak | Before each staging pilot run |
| `reports/staging-soak-report.json` | Latest staged soak report artifact | After each soak execution |

## Refresh Workflow

1. Run runtime checks:

```bash
npm run type-check
npm run parity:contract
npm run test:native-runtime
cargo check --keep-going --manifest-path src-tauri/Cargo.toml
```

2. Execute/manual-collect staging evidence when required:

```bash
node scripts/tauri-smoke.mjs --report docs/security-native-migration/reports/staging-soak-report.json
npm run soak:report
```

3. Update the affected artifact files in this folder in the same PR.
4. Keep dates explicit (`YYYY-MM-DD`) in each status summary section.

## Related Runtime Docs

- `../../README.md`
- `../../ARCHITECTURE.md`
- `../../PARITY_GATES.md`
- `../../PARITY_CHECKLIST.md`
- `../../SUPPORT.md`
- `../../RELEASE.md`
