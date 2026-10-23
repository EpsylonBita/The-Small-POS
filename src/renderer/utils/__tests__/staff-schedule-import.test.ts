import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { importStaffScheduleFile, toBranchInstant } from '../staff-schedule-import';

const ctx = { timeZone: 'Pacific/Honolulu', staffList: [{ id: 'staff', name: 'Ana' }] };
const athens = { ...ctx, timeZone: 'Europe/Athens' };
function matrixFile(rows: unknown[][]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Schedule');
  return { name: 'schedule.xlsx', arrayBuffer: async () => XLSX.write(book, { type: 'array', bookType: 'xlsx' }) } as File;
}
function columnsFile(rows: Array<Record<string, unknown>>, options: { date1904?: boolean } = {}) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Shifts');
  if (options.date1904) {
    book.Workbook = { ...(book.Workbook ?? {}), WBProps: { date1904: true } };
  }
  return { name: 'shifts.xlsx', arrayBuffer: async () => XLSX.write(book, { type: 'array', bookType: 'xlsx' }) } as File;
}
const textFile = (name: string, text: string) => ({ name, text: async () => text }) as File;
const jsonFile = (shifts: Array<Record<string, unknown>>) => textFile('shifts.json', JSON.stringify({ shifts }));
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

// Vertical salon follow-ups item 4 (21/10/2026): every non-matrix format
// sends instants with `Z`, read in the branch zone.
describe('column and calendar imports send branch instants', () => {
  it('reads naive column times in the branch zone, in the T and the space form', async () => {
    const result = await importStaffScheduleFile(columnsFile([
      { 'Staff Name': 'Ana', 'Start Time': '2026-10-21T09:00:00', 'End Time': '2026-10-21 17:00', 'Break Start': '2026-10-21 12:00:00.250', 'Break End': '' },
    ]), ctx);
    expect(result.shifts).toEqual([{
      staffId: 'staff',
      startTime: '2026-10-21T19:00:00.000Z',
      endTime: '2026-10-22T03:00:00.000Z',
      breakStart: '2026-10-21T22:00:00.250Z',
      breakEnd: null,
      status: undefined,
      notes: null,
    }]);
    expect(result.invalidRows).toBe(0);
  });

  it('reads an Excel serial as a branch wall-clock time whatever the machine zone', async () => {
    const machineZone = process.env.TZ;
    try {
      for (const zone of ['America/New_York', 'Asia/Tokyo', 'UTC']) {
        process.env.TZ = zone;
        expect(toBranchInstant(46316.375, { timeZone: 'Europe/Athens' })).toBe('2026-10-21T06:00:00.000Z');
        const result = await importStaffScheduleFile(columnsFile([
          { 'Staff Name': 'Ana', 'Start Time': 46316.375, 'End Time': 46316.708333333336 },
        ]), athens);
        expect(result.shifts).toMatchObject([{ startTime: '2026-10-21T06:00:00.000Z', endTime: '2026-10-21T14:00:00.000Z' }]);
      }
    } finally {
      if (machineZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = machineZone;
      }
    }
  });

  it('honours a workbook on the 1904 date system', async () => {
    expect(toBranchInstant(44854.375, { timeZone: 'Europe/Athens', date1904: true })).toBe('2026-10-21T06:00:00.000Z');
    const result = await importStaffScheduleFile(columnsFile([
      { 'Staff Name': 'Ana', 'Start Time': 44854.375, 'End Time': 44854.708333333336 },
    ], { date1904: true }), athens);
    expect(result.shifts).toMatchObject([{ startTime: '2026-10-21T06:00:00.000Z', endTime: '2026-10-21T14:00:00.000Z' }]);
  });

  it('normalises an offset to Z and keeps a Z instant, with or without a branch zone', async () => {
    const rows = [
      { staffName: 'Ana', startTime: '2026-10-21T09:00:00+03:00', endTime: '2026-10-21T14:00:00.000Z' },
      { staffName: 'Ana', startTime: '2026-10-22T09:00:00+0300', endTime: '2026-10-22T17:00+03' },
    ];
    for (const context of [athens, { staffList: ctx.staffList }]) {
      const result = await importStaffScheduleFile(jsonFile(rows), context);
      expect(result.shifts).toMatchObject([
        { startTime: '2026-10-21T06:00:00.000Z', endTime: '2026-10-21T14:00:00.000Z' },
        { startTime: '2026-10-22T06:00:00.000Z', endTime: '2026-10-22T14:00:00.000Z' },
      ]);
    }
  });

  it('converts both breaks, and an empty break stays null', async () => {
    const result = await importStaffScheduleFile(jsonFile([
      { staffName: 'Ana', startTime: '2026-10-21 09:00', endTime: '2026-10-21 17:00', breakStart: '2026-10-21 12:00', breakEnd: '2026-10-21T12:30:00' },
      { staffName: 'Ana', startTime: '2026-10-22 09:00', endTime: '2026-10-22 17:00', breakStart: '', breakEnd: null },
    ]), athens);
    expect(result.shifts).toMatchObject([
      { breakStart: '2026-10-21T09:00:00.000Z', breakEnd: '2026-10-21T09:30:00.000Z' },
      { startTime: '2026-10-22T06:00:00.000Z', breakStart: null, breakEnd: null },
    ]);
  });

  it('refuses a DST gap and a missing branch zone for wall-clock times', async () => {
    await expect(importStaffScheduleFile(jsonFile([
      { staffName: 'Ana', startTime: '2026-03-29 03:30', endTime: '2026-03-29 09:00' },
    ]), athens)).rejects.toThrow('BRANCH_TIME_INVALID');
    await expect(importStaffScheduleFile(jsonFile([
      { staffName: 'Ana', startTime: '2026-10-21 09:00', endTime: '2026-10-21 17:00' },
    ]), { staffList: ctx.staffList })).rejects.toThrow('TIMEZONE_UNAVAILABLE');
    await expect(importStaffScheduleFile(columnsFile([
      { 'Staff Name': 'Ana', 'Start Time': 46316.375, 'End Time': 46316.708333333336 },
    ]), { staffList: ctx.staffList })).rejects.toThrow('TIMEZONE_UNAVAILABLE');
    expect(() => toBranchInstant('09:00', {}, '2026-10-21')).toThrow('TIMEZONE_UNAVAILABLE');
  });

  it('reads clock times on the date column and rolls an overnight end to the next day', async () => {
    const result = await importStaffScheduleFile(columnsFile([
      { Staff: 'Ana', Date: 46316, 'Start Time': '22:00', 'End Time': '02:00', 'Break Start': '23:30', 'Break End': '00:15' },
      { Staff: 'Ana', shift_date: '2026-10-22', 'Start Time': 0.375, 'End Time': 0.708333333333333 },
    ]), athens);
    expect(result.shifts).toMatchObject([
      {
        startTime: '2026-10-21T19:00:00.000Z',
        endTime: '2026-10-21T23:00:00.000Z',
        breakStart: '2026-10-21T20:30:00.000Z',
        breakEnd: '2026-10-21T21:15:00.000Z',
      },
      { startTime: '2026-10-22T06:00:00.000Z', endTime: '2026-10-22T14:00:00.000Z' },
    ]);
  });

  it('skips a row whose time cannot be read and never sends it raw', async () => {
    const result = await importStaffScheduleFile(jsonFile([
      { staffName: 'Ana', startTime: '2026-10-21 09:00', endTime: '2026-10-21 17:00' },
      { staffName: 'Ana', startTime: 'tomorrow at nine', endTime: '2026-10-21 17:00' },
      { staffName: 'Ana', startTime: '09:00', endTime: '17:00' },
      { staffName: 'Ana', startTime: '2026-02-31 09:00', endTime: '2026-02-31 17:00' },
      { staffName: 'Ana', startTime: '2026-10-21 09:00', endTime: '2026-10-21 17:00', breakStart: 'lunch' },
      { staffName: 'Ana', startTime: '46316.375', endTime: '46316.7' },
    ]), athens);
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0]).toMatchObject({ startTime: '2026-10-21T06:00:00.000Z', endTime: '2026-10-21T14:00:00.000Z' });
    expect(result.invalidRows).toBe(5);
    expect(toBranchInstant('09:00', athens)).toBeNull();
    expect(toBranchInstant({ when: 'now' }, athens)).toBeNull();
  });

  it('reads CSV times in the branch zone', async () => {
    const csv = [
      'staff_name,date,start_time,end_time,break_start,break_end',
      'Ana,2026-10-21,09:00,17:00,,',
      'Ana,,2026-10-22 22:00,2026-10-23 06:00,,',
    ].join('\n');
    const result = await importStaffScheduleFile(textFile('shifts.csv', csv), athens);
    expect(result.format).toBe('csv');
    expect(result.shifts).toMatchObject([
      { startTime: '2026-10-21T06:00:00.000Z', endTime: '2026-10-21T14:00:00.000Z', breakStart: null, breakEnd: null },
      { startTime: '2026-10-22T19:00:00.000Z', endTime: '2026-10-23T03:00:00.000Z' },
    ]);
  });

  it('reads ICS times in their TZID zone, Z as given and floating times in the branch zone', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'DTSTART;TZID=Europe/Athens:20261021T090000', 'DTEND;TZID="Europe/Athens":20261021T170000', 'SUMMARY:Shift: Ana', 'END:VEVENT',
      'BEGIN:VEVENT', 'DTSTART:20261022T060000Z', 'DTEND:20261022T140000Z', 'SUMMARY:Ana', 'END:VEVENT',
      'BEGIN:VEVENT', 'DTSTART:20261023T090000', 'DTEND:20261023T170000', 'SUMMARY:Ana', 'END:VEVENT',
      'BEGIN:VEVENT', 'DTSTART;TZID=Mars/Olympus:20261024T090000', 'DTEND;TZID=Mars/Olympus:20261024T170000', 'SUMMARY:Ana', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = await importStaffScheduleFile(textFile('shifts.ics', ics), ctx);
    expect(result.shifts).toMatchObject([
      { startTime: '2026-10-21T06:00:00.000Z', endTime: '2026-10-21T14:00:00.000Z' },
      { startTime: '2026-10-22T06:00:00.000Z', endTime: '2026-10-22T14:00:00.000Z' },
      { startTime: '2026-10-23T19:00:00.000Z', endTime: '2026-10-24T03:00:00.000Z' },
    ]);
    expect(result.invalidRows).toBe(1);
  });
});
