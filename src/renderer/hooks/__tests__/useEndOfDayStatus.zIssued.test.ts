import { describe, expect, it } from 'vitest';
import type { EndOfDayStatusResponse } from '../../../lib/ipc-contracts';
import { isZIssuedAwaitingFinalization } from '../useEndOfDayStatus';

const status = (patch: Partial<EndOfDayStatusResponse>): EndOfDayStatusResponse => ({
  status: 'idle',
  pendingReportDate: null,
  cutoffAt: null,
  periodStartAt: null,
  activeReportDate: null,
  activePeriodStartAt: null,
  latestZReportId: null,
  latestZReportSyncState: null,
  canOpenPendingZReport: false,
  ...patch,
});

describe('issued Z awaiting finalization (Health support warning, 13/10/2026)', () => {
  it('is a Z generated and queued whose local day close has not run', () => {
    expect(isZIssuedAwaitingFinalization(status({ status: 'pending_local_submit', zIssued: true }))).toBe(true);
  });

  it('is never a day whose Z is simply ready after the last checkout', () => {
    expect(isZIssuedAwaitingFinalization(status({ status: 'pending_local_submit', zIssued: false }))).toBe(false);
    expect(isZIssuedAwaitingFinalization(status({ status: 'pending_local_submit' }))).toBe(false);
  });

  it('is never an idle or already submitted day', () => {
    expect(isZIssuedAwaitingFinalization(status({ status: 'idle', zIssued: true }))).toBe(false);
    expect(isZIssuedAwaitingFinalization(status({ status: 'submitted_pending_admin' }))).toBe(false);
  });
});
