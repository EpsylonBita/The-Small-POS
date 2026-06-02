# Offline Sync Telemetry QA

Last reviewed: 2026-05-12

Linear: THE-99

Project closeout: `docs/architecture/pos-runtime-offline-sync-closeout.md`

## Purpose

Use this checklist to verify that offline POS replay is observable without
logging queued payloads, customer PII, or terminal API keys.

## Preconditions

- A configured Tauri POS terminal with `terminal_id`, `organization_id`, `branch_id`, and `pos_api_key` present through the normal keyring/bootstrap flow.
- Admin dashboard reachable before the test starts.
- Diagnostics export available from the POS support/recovery surface.

## Network Loss And Restoration

1. Start online and confirm `SyncStatusIndicator` shows no failed parity rows.
2. Disable network access for the terminal.
3. Create a pickup order with a non-sensitive test customer name and cash payment.
4. Confirm the UI returns immediately and the order remains visible locally.
5. Open the recovery/diagnostics surface and confirm parity queue status shows at least one pending row.
6. Restore network access.
7. Trigger manual sync or wait for the scheduled reconnect replay.
8. Confirm the queued order leaves `parity_sync_queue` and the admin order endpoint receives one replay.
9. Export diagnostics and inspect `last_parity_sync.json`.

Expected telemetry:

- `telemetry.queueDepthBefore` is at least `1`.
- `telemetry.queueDepthAfter` returns to `0` after successful replay.
- `telemetry.replayAttempts` increments for the replay batch.
- `telemetry.scope.organizationId` and `telemetry.scope.terminalId` identify the terminal context.
- `telemetry.outcomes` includes an `orders / processed / none` group.
- The JSON does not include the POS API key, queued order payload, customer name, phone, email, notes, or address.

## Terminal Auth Failure

1. Use a test terminal profile and remove or corrupt the local `terminal_id`.
2. Create an offline queue row or retry an existing pending row.
3. Run parity replay.
4. Restore the valid terminal configuration after the failure is visible.

Expected telemetry:

- `telemetry.terminalAuthFailures` is greater than `0`.
- `telemetry.outcomes` includes a `terminal_auth` error class.
- Queue rows remain actionable as `failed` or are requeued after terminal context is restored.
- Diagnostics should name the failure class, not expose the API key or queued payload.

## Conflict And Rate Limit Checks

1. Force a test admin response with HTTP `409` or `412` for an order/catalog replay.
2. Confirm telemetry reports a `conflict` error class and the row moves to `conflict` when operator review is required.
3. Force a test admin response with HTTP `429`.
4. Confirm telemetry reports `rate_limited`, keeps the row pending, and records a retry schedule.

## Evidence To Attach

- `last_parity_sync.json`
- `parity_queue_status.json`
- `parity_failure_families.json`
- A screenshot of the recovery surface before and after reconnect.
