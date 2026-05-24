import type { TFunction } from 'i18next';
import { emitCompatEvent, getBridge } from '../../lib';
import type { ResetStartResponse, ResetStatus } from '../../lib/ipc-contracts';
import { withTimeout } from '../../shared/utils/error-handler';

const RESET_START_TIMEOUT_MS = 4000;
const RESET_STATUS_LOOKUP_TIMEOUT_MS = 1200;
const RESET_STATUS_FRESH_GRACE_MS = 5000;

type ResetStartResult = ResetStartResponse;

function getResetStartTimeoutMessage(t: TFunction): string {
  return t(
    'settings.database.factoryResetTimedOut',
    'Reset startup took too long. Please try again.',
  );
}

function buildResetStartedFromStatus(status: ResetStatus): ResetStartResponse {
  return {
    success: true,
    started: true,
    operationId: status.operationId,
    mode: status.mode,
  };
}

function isFreshResetStatus(
  status: ResetStatus | null,
  actionStartedAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!status) {
    return false;
  }

  const updatedAtMs = Date.parse(status.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return (
    updatedAtMs >= actionStartedAtMs - RESET_STATUS_FRESH_GRACE_MS &&
    updatedAtMs <= nowMs + RESET_STATUS_FRESH_GRACE_MS
  );
}

export function isResetStartFallbackStatus(
  status: ResetStatus | null,
  actionStartedAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!status || !isFreshResetStatus(status, actionStartedAtMs, nowMs)) {
    return false;
  }

  return (
    status.state === 'running' &&
    status.phase !== 'completed' &&
    status.phase !== 'failed'
  );
}

function emitLateResetStarted(result: ResetStartResponse): void {
  if (!result?.success || !result?.started) {
    return;
  }

  emitCompatEvent('reset:started', {
    operationId: result.operationId ?? null,
    mode: result.mode ?? null,
    phase: 'preparing',
    state: 'running',
    updatedAt: new Date().toISOString(),
  });
}

function emitLateResetFailure(errorMessage: string): void {
  emitCompatEvent('reset:failed', {
    operationId: null,
    mode: null,
    phase: 'failed',
    state: 'failed',
    errorMessage,
    updatedAt: new Date().toISOString(),
  });
}

async function readPersistedResetStatus(): Promise<ResetStatus | null> {
  try {
    const bridge = getBridge();
    const status = await withTimeout(
      bridge.settings.getResetStatus(),
      RESET_STATUS_LOOKUP_TIMEOUT_MS,
      'Reset status lookup timed out',
    );
    return status && typeof status === 'object' ? (status as ResetStatus) : null;
  } catch (error) {
    console.warn('[reset-actions] Failed to inspect reset status:', error);
    return null;
  }
}

export async function startResetAction(
  action: () => Promise<ResetStartResult>,
  t: TFunction,
): Promise<ResetStartResult> {
  const timeoutMessage = getResetStartTimeoutMessage(t);
  const actionStartedAtMs = Date.now();
  const actionPromise = action();

  try {
    const result = await withTimeout(
      actionPromise,
      RESET_START_TIMEOUT_MS,
      timeoutMessage,
    );

    if (result?.success && result?.started) {
      return result;
    }

    const persistedStatus = await readPersistedResetStatus();
    if (persistedStatus && isResetStartFallbackStatus(persistedStatus, actionStartedAtMs)) {
      return buildResetStartedFromStatus(persistedStatus);
    }

    if (
      persistedStatus?.state === 'failed' &&
      persistedStatus.errorMessage &&
      isFreshResetStatus(persistedStatus, actionStartedAtMs)
    ) {
      throw new Error(persistedStatus.errorMessage);
    }

    throw new Error(
      result?.error ||
        t(
          'settings.database.resetLaunchFailed',
          'Failed to start the reset.',
        ),
    );
  } catch (error) {
    if (error instanceof Error && error.message === timeoutMessage) {
      const persistedStatus = await readPersistedResetStatus();
      if (persistedStatus && isResetStartFallbackStatus(persistedStatus, actionStartedAtMs)) {
        return buildResetStartedFromStatus(persistedStatus);
      }

      console.warn('[reset-actions] Reset start timed out; continuing to observe late completion');
      void actionPromise
        .then((lateResult) => {
          if (lateResult?.success && lateResult?.started) {
            emitLateResetStarted(lateResult);
            return;
          }

          if (lateResult?.error) {
            emitLateResetFailure(lateResult.error);
          }
        })
        .catch((lateError) => {
          const lateMessage =
            lateError instanceof Error ? lateError.message : timeoutMessage;
          console.warn('[reset-actions] Late reset start resolution failed:', lateError);
          emitLateResetFailure(lateMessage);
        });
      throw new Error(timeoutMessage);
    }

    const persistedStatus = await readPersistedResetStatus();
    if (persistedStatus && isResetStartFallbackStatus(persistedStatus, actionStartedAtMs)) {
      return buildResetStartedFromStatus(persistedStatus);
    }

    if (
      persistedStatus?.state === 'failed' &&
      persistedStatus.errorMessage &&
      isFreshResetStatus(persistedStatus, actionStartedAtMs)
    ) {
      throw new Error(persistedStatus.errorMessage);
    }

    throw error;
  }
}

export function getResetStartingMessage(t: TFunction): string {
  return t(
    'settings.database.resetStarting',
    'Reset started. The POS will close, wipe local data, and relaunch into setup.'
  );
}
