import { afterEach, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { importStaffScheduleFile } from '../staff-schedule-import';

const ctx = { timeZone: 'Pacific/Honolulu', staffList: [{ id: 'staff', name: 'Ana' }] };
function matrixFile(rows: unknown[][]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Schedule');
  return { name: 'schedule.xlsx', arrayBuffer: async () => XLSX.write(book, { type: 'array', bookType: 'xlsx' }) } as File;
}
afterEach(() => vi.useRealTimers());

it('imports spreadsheet wall times in the branch zone, including overnight shifts', async () => {
  const result = await importStaffScheduleFile(matrixFile([
    ['', '2026-10-19', '2026-10-20', '2026-10-21'], ['Staff', 'Monday', 'Tuesday', 'Wednesday'], ['Ana', '22:00-02:00', 'OFF', 'OFF'],
  ]), ctx);
  expect(result.shifts).toMatchObject([{ staffId: 'staff', startTime: '2026-10-20T08:00:00.000Z', endTime: '2026-10-20T12:00:00.000Z' }]);
});
it('anchors an undated week to the branch calendar and refuses a missing branch zone', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T05:00:00Z')); // Sunday in Honolulu
  const file = matrixFile([['Staff', 'Monday', 'Tuesday', 'Wednesday'], ['Ana', '09:00-17:00', 'OFF', 'OFF']]);
  expect((await importStaffScheduleFile(file, ctx)).shifts[0].startTime).toBe('2026-10-12T19:00:00.000Z');
  await expect(importStaffScheduleFile(file, { staffList: ctx.staffList })).rejects.toThrow('TIMEZONE_UNAVAILABLE');
});
it('rejects a spreadsheet shift in a branch DST gap', async () => {
  await expect(importStaffScheduleFile(matrixFile([
    ['', '2026-03-29', '2026-03-30', '2026-03-31'], ['Staff', 'Sunday', 'Monday', 'Tuesday'], ['Ana', '03:30-06:00', 'OFF', 'OFF'],
  ]), { ...ctx, timeZone: 'Europe/Athens' })).rejects.toThrow('BRANCH_TIME_INVALID');
});
