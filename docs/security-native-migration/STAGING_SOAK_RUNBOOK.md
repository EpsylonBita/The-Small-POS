# POS Tauri Staging Soak Runbook (24h)

## Goal
Complete the pending native-only rollout gate: one pilot terminal, 24-hour soak, forced offline/online transitions, and auditable evidence.

## Preconditions
1. Build deployed from current native-only branch.
2. Staging terminal has valid pairing credentials.
3. Terminal has local printer profile configured.
4. Tester has access to staging admin dashboard and terminal logs.

## Commands
Run from `pos-tauri/`.

1. Baseline contracts:
```bash
npm run type-check
npm run parity:contract
npm run test:native-runtime
```

2. Start app:
```bash
npm run pos:tauri:dev
```

3. Run manual gate checklist with report export (in a separate terminal):
```bash
node scripts/tauri-smoke.mjs --report docs/security-native-migration/reports/staging-soak-report.json
```

4. Evaluate the report after manual execution:
```bash
npm run soak:report
```

5. Optional gate list only:
```bash
node scripts/tauri-smoke.mjs --list
```

6. Optional dry-run report generation (no manual prompts):
```bash
node scripts/tauri-smoke.mjs --auto skip --report docs/security-native-migration/reports/staging-soak-dry-run.json
```

## Execution Plan (24h)
1. Hour 0-1:
- Validate startup, login, and baseline order flow online.
- Run initial smoke gates and record notes.

2. Hour 1-12:
- Force offline mode for extended period.
- Execute offline-critical flows:
  - order create/update/delete
  - payment + receipt preview/print queue
  - shift open/close
  - z-report generation
- Restart app at least once while offline.

3. Hour 12-18:
- Restore network.
- Confirm deferred queue drain and no duplicate writes.
- Verify sync/financial states converge.

4. Hour 18-24:
- Repeat mixed load (online/offline toggles).
- Confirm stability of logs, menu monitor behavior, and print pipeline.

## Required Evidence
1. `docs/security-native-migration/reports/staging-soak-report.json`
2. Terminal logs covering:
- offline period
- reconnect window
- queue drain period
3. Admin-side verification notes:
- no duplicate orders/payments
- expected final shift/report totals

## Exit Criteria
1. No critical gate failures in report.
2. `npm run soak:report` exits with success (`Soak gate approved`).
3. Offline-created data persists across restart and syncs after reconnect.
4. No Electron compatibility/runtime dependencies observed.
5. No blocking regressions in print/sync/auth core flows.
