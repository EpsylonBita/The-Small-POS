import { beforeEach, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { CHANNEL_MAP, TauriBridge } from '../ipc-adapter';

beforeEach(() => { invoke.mockReset(); });

// The Z export reads the stored Zs (founder, 14/10/2026) through the two
// existing native commands `zreport_list` / `zreport_get` (lib.rs).
it('lists the stored Zs through zreport_list, the last 30 days without a filter', async () => {
  const response = { success: true, reports: [{ id: 'zr-1' }], count: 1 };
  invoke.mockResolvedValue(response);
  const bridge = new TauriBridge();

  expect(await bridge.reports.listZReports()).toEqual(response);
  expect(invoke).toHaveBeenLastCalledWith('zreport_list', undefined);

  await bridge.reports.listZReports({ startDate: '2026-10-01', endDate: '2026-10-14' });
  expect(invoke).toHaveBeenLastCalledWith('zreport_list', { arg0: { startDate: '2026-10-01', endDate: '2026-10-14' } });
  expect(CHANNEL_MAP['zreport:list']).toBe('reports.listZReports');
});

it('reads one stored Z by id through zreport_get and keeps a refusal a refusal', async () => {
  invoke.mockResolvedValueOnce({ success: true, report: { id: 'zr-7' } });
  const bridge = new TauriBridge();

  expect(await bridge.reports.getZReport({ zReportId: 'zr-7' })).toEqual({ success: true, report: { id: 'zr-7' } });
  expect(invoke).toHaveBeenLastCalledWith('zreport_get', { arg0: { zReportId: 'zr-7' } });
  expect(CHANNEL_MAP['zreport:get']).toBe('reports.getZReport');

  invoke.mockRejectedValueOnce('Z-report not found: zr-missing');
  await expect(bridge.reports.getZReport({ zReportId: 'zr-missing' })).rejects.toBe('Z-report not found: zr-missing');
});
