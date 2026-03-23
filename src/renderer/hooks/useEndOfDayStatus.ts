import { useCallback, useEffect, useState } from 'react';
import { getBridge, offEvent, onEvent } from '../../lib';
import type { EndOfDayStatusResponse } from '../../lib/ipc-contracts';
import { toLocalDateString } from '../utils/date';
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
};

export function useEndOfDayStatus(branchId?: string | null) {
  const bridge = getBridge();
  const now = useSystemClock();
  const currentDate = toLocalDateString(now);
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
  }, [currentDate, refreshEndOfDayStatus]);

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
    isSubmittedPendingAdmin: endOfDayStatus.status === 'submitted_pending_admin',
  };
}
