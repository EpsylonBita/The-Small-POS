import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteIncidentReportResponse } from '../../../../lib';

const mocks = vi.hoisted(() => ({
  list: vi.fn<() => Promise<RemoteIncidentReportResponse[]>>(),
  listeners: new Set<() => Promise<void>>(),
}));
vi.mock('../../../../lib', () => ({
  getBridge: () => ({ diagnostics: { listReports: mocks.list } }),
  onEvent: (_event: string, refresh: () => Promise<void>) => mocks.listeners.add(refresh),
  offEvent: (_event: string, refresh: () => Promise<void>) => mocks.listeners.delete(refresh),
}));
vi.mock('../../../services/support/SupportRemedyRunner', () => ({
  verifiedSupportReceipt: (report: RemoteIncidentReportResponse) =>
    report.success && report.bundleStored && Boolean(report.incidentId),
}));

import { useTillHealthReports } from '../useTillHealthReports';

describe('native Health report archive', () => {
  it('updates the newest queued report from native and includes earlier local copies', async () => {
    const local: RemoteIncidentReportResponse = {
      success: false, localPrepared: true, deliveryState: 'local', historical: true,
      reportId: 'older', path: 'C:/till/older.zip', createdAt: '2026-11-18T08:00:00Z',
    };
    const waiting: RemoteIncidentReportResponse = {
      success: false, localPrepared: true, deliveryState: 'waiting',
      reportId: 'newer', path: 'C:/till/newer.zip', createdAt: '2026-11-18T09:00:00Z',
    };
    mocks.list.mockResolvedValue([local, waiting]);
    const { result, unmount } = renderHook(() => useTillHealthReports('one pairing', true));
    await waitFor(() => expect(result.current.last?.result).toEqual(waiting));
    expect(result.current.copies.map(report => report.result.reportId)).toEqual(['newer', 'older']);

    const sent: RemoteIncidentReportResponse = {
      ...waiting, success: true, deliveryState: 'sent', bundleStored: true,
      incidentId: 'confirmed', lastSentAt: '2026-11-18T10:00:00Z',
    };
    mocks.list.mockResolvedValue([local, sent]);
    await act(async () => { await Promise.all([...mocks.listeners].map(refresh => refresh())); });
    expect(result.current.last?.result).toEqual(sent);
    expect(result.current.copies).toHaveLength(2);
    unmount();
    expect(mocks.listeners.size).toBe(0);
  });
});
