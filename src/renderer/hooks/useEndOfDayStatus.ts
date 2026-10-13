import { useCallback, useEffect, useState } from 'react';
import { getBridge, offEvent, onEvent } from '../../lib';
import type { EndOfDayStatusResponse } from '../../lib/ipc-contracts';
import { useSystemClock } from './useSystemClock';

const IDLE_END_OF_DAY_STATUS: EndOfDayStatusResponse = {
  status: 'idle',
  pendingReportDate: null,
  cutoffAt: null,
  periodStartAt: null,
  activeReportDate: null,
  activePeriodStartAt: null,
  latestZReportId: null,
  latestZReportSyncState: null,
  canOpenPendingZReport: false,
  dayStartAt: null,
  zIssued: false,
};

/**
 * A Z already issued (generated and queued) whose local day close has not run
 * yet, e.g. because its post-submission sync failed. Health raises its support
 * warning only for this; a day whose Z is simply ready after the last checkout
 * is the normal day close (founder rules 13/10/2026).
 */
export function isZIssuedAwaitingFinalization(status: EndOfDayStatusResponse): boolean {
  return status.status === 'pending_local_submit' && status.zIssued === true;
}

export function useEndOfDayStatus(branchId?: string | null) {
  const bridge = getBridge();
  const now = useSystemClock();
  const [endOfDayStatus, setEndOfDayStatus] = useState<EndOfDayStatusResponse>(
    IDLE_END_OF_DAY_STATUS
  );
  const [loadingEndOfDayStatus, setLoadingEndOfDayStatus] = useState(false);

  const refreshEndOfDayStatus = useCallback(async () => {
    const normalizedBranchId = branchId?.trim();
    if (!normalizedBranchId) {
      setEndOfDayStatus(IDLE_END_OF_DAY_STATUS);
      return;
    }

    setLoadingEndOfDayStatus(true);
    try {
      const nextStatus = await bridge.reports.getEndOfDayStatus({
        branchId: normalizedBranchId,
      });
      setEndOfDayStatus({
        ...IDLE_END_OF_DAY_STATUS,
        ...(nextStatus || {}),
      });
    } catch (error) {
      console.warn('[useEndOfDayStatus] Failed to load pending EOD status:', error);
      setEndOfDayStatus(IDLE_END_OF_DAY_STATUS);
    } finally {
      setLoadingEndOfDayStatus(false);
    }
  }, [branchId, bridge]);

  useEffect(() => {
    void refreshEndOfDayStatus();
  }, [now, refreshEndOfDayStatus]);

  useEffect(() => {
    const handleShiftUpdated = () => {
      void refreshEndOfDayStatus();
    };

    onEvent('shift-updated', handleShiftUpdated);
    return () => {
      offEvent('shift-updated', handleShiftUpdated);
    };
  }, [refreshEndOfDayStatus]);

  return {
    endOfDayStatus,
    loadingEndOfDayStatus,
    refreshEndOfDayStatus,
    isPendingLocalSubmit: endOfDayStatus.status === 'pending_local_submit',
    isZIssuedAwaitingFinalization: isZIssuedAwaitingFinalization(endOfDayStatus),
    isSubmittedPendingAdmin: endOfDayStatus.status === 'submitted_pending_admin',
  };
}
