import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResetStatus } from '../../src/lib/ipc-contracts';
import { isResetStartFallbackStatus } from '../../src/renderer/utils/reset-actions';

const baseStatus: ResetStatus = {
  operationId: 'reset-1',
  mode: 'factory_reset',
  phase: 'preparing',
  state: 'running',
  updatedAt: '2026-05-23T10:00:00.000Z',
  errorCode: null,
  errorMessage: null,
  failingKey: null,
  failingPath: null,
};

test('reset start fallback accepts only fresh running reset status', () => {
  const actionStartedAtMs = Date.parse('2026-05-23T10:00:01.000Z');
  const nowMs = Date.parse('2026-05-23T10:00:02.000Z');

  assert.equal(
    isResetStartFallbackStatus(baseStatus, actionStartedAtMs, nowMs),
    true,
  );

  assert.equal(
    isResetStartFallbackStatus(
      {
        ...baseStatus,
        phase: 'completed',
        state: 'completed',
      },
      actionStartedAtMs,
      nowMs,
    ),
    false,
  );

  assert.equal(
    isResetStartFallbackStatus(
      {
        ...baseStatus,
        updatedAt: '2026-05-23T09:59:00.000Z',
      },
      actionStartedAtMs,
      nowMs,
    ),
    false,
  );
});

test('reset start fallback rejects stale completed status from prior resets', () => {
  const actionStartedAtMs = Date.parse('2026-05-23T10:00:01.000Z');
  const nowMs = Date.parse('2026-05-23T10:00:02.000Z');

  assert.equal(
    isResetStartFallbackStatus(
      {
        ...baseStatus,
        operationId: 'old-reset',
        phase: 'completed',
        state: 'completed',
        updatedAt: '2026-05-18T17:42:11.717Z',
      },
      actionStartedAtMs,
      nowMs,
    ),
    false,
  );
});
