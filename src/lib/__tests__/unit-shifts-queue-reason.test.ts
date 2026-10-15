/**
 * A queued Z the server holds for open phone shifts reads in the store's
 * language with the shifts' names, never the stored code (founder rule
 * 13/10/2026, coordinator review 14/10/2026).
 */
import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { formatUnitShiftsQueueReason, unitShiftsQueueReasonNames } from '../unit-shifts-queue-reason';
import { getLocalizedSyncBlockerReason } from '../payment-integrity';

const t = ((key: string, options?: { defaultValue?: string; shifts?: string }) =>
  `${key}|${options?.shifts ?? ''}`) as unknown as TFunction;

describe('unit shifts queue reason', () => {
  it('reads the code and the names', () => {
    expect(unitShiftsQueueReasonNames('Z_REPORT_UNIT_SHIFTS_OPEN: Maria (Phone 1), Nikos (Phone 2)'))
      .toBe('Maria (Phone 1), Nikos (Phone 2)');
    expect(unitShiftsQueueReasonNames('Z_REPORT_UNIT_SHIFTS_OPEN')).toBe('');
    // A reason stored with the server's English sentence keeps only the names.
    expect(unitShiftsQueueReasonNames('Z_REPORT_UNIT_SHIFTS_OPEN: Close the phone shifts before the Z: Maria (waiter, Phone 1)'))
      .toBe('Maria (waiter, Phone 1)');
    expect(unitShiftsQueueReasonNames('HTTP 500')).toBeNull();
    expect(unitShiftsQueueReasonNames(null)).toBeNull();
  });

  it('formats the sentence with the names, or without when there are none', () => {
    expect(formatUnitShiftsQueueReason('Z_REPORT_UNIT_SHIFTS_OPEN: Maria (Phone 1)', t))
      .toBe('sync.blockerReasons.zReportUnitShiftsOpen|Maria (Phone 1)');
    expect(formatUnitShiftsQueueReason('Z_REPORT_UNIT_SHIFTS_OPEN', t))
      .toBe('sync.blockerReasons.zReportUnitShiftsOpenUnnamed|');
    expect(formatUnitShiftsQueueReason('Waiting for parent order sync', t)).toBeNull();
  });

  it('is what a closeout blocker of a held Z says', () => {
    expect(getLocalizedSyncBlockerReason({
      blockerReason: 'Z_REPORT_UNIT_SHIFTS_OPEN: Maria (Phone 1)',
      entityType: 'z_report',
      queueStatus: 'pending',
      lastError: 'Z_REPORT_UNIT_SHIFTS_OPEN: Maria (Phone 1)',
    } as any, t)).toBe('sync.blockerReasons.zReportUnitShiftsOpen|Maria (Phone 1)');
  });
});
