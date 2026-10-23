import { branchWallTime, branchWallTimeToIso } from './branch-time';

export type ScheduleImportShiftStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';

export interface ImportedScheduleShift {
  staffId: string;
  startTime: string;
  endTime: string;
  breakStart: string | null;
  breakEnd: string | null;
  status?: ScheduleImportShiftStatus;
  notes?: string | null;
}

export interface ScheduleImportStaff {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  staffCode?: string | null;
  name?: string | null;
}

export interface ScheduleImportContext {
  staffList?: ScheduleImportStaff[];
  timeZone?: string;
}

export interface ScheduleImportResult {
  shifts: ImportedScheduleShift[];
  format: 'json' | 'csv' | 'xlsx' | 'ics' | 'pdf' | 'docx' | 'txt' | null;
  unmatchedStaffLabels?: string[];
  /** Rows skipped because a time could not be read; never sent raw. */
  invalidRows?: number;
}

/** What `toBranchInstant` needs: the branch zone and the workbook's date system. */
export interface BranchInstantContext {
  timeZone?: string;
  /** The workbook counts serial dates from 1904-01-01 (Mac Excel). */
  date1904?: boolean;
}

type RowsContext = ScheduleImportContext & BranchInstantContext;

interface RowsResult {
  shifts: ImportedScheduleShift[];
  invalidRows: number;
}

export const STAFF_SCHEDULE_IMPORT_ACCEPT =
  '.json,.csv,.xlsx,.xls,.ics,.pdf,.docx,.doc,.txt,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/calendar,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';

const META_BEGIN = '__SCHEDULE_DATA_BEGIN__';
const META_END = '__SCHEDULE_DATA_END__';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_STATUSES: ScheduleImportShiftStatus[] = ['scheduled', 'active', 'completed', 'cancelled'];

const DAY_KEYWORDS: Record<string, number> = {
  'ΔΕΥΤΕΡΑ': 1,
  'ΤΡΙΤΗ': 2,
  'ΤΕΤΑΡΤΗ': 3,
  'ΠΕΜΠΤΗ': 4,
  'ΠΑΡΑΣΚΕΥΗ': 5,
  'ΣΑΒΒΑΤΟ': 6,
  'ΚΥΡΙΑΚΗ': 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
  SUN: 0,
};

const OFF_MARKERS = new Set([
  'ΡΕΠΟ',
  'ΡΕΠΟΣ',
  'ΡΕΠΟ.',
  'ΑΔΕΙΑ',
  'ΕΛΕΥΘΕΡΟ',
  'OFF',
  'REST',
  'DAYOFF',
  'DAY-OFF',
  '-',
  'X',
  '*',
]);

function readString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function normalizeStatus(value: unknown): ScheduleImportShiftStatus | undefined {
  const status = readString(value)?.toLowerCase();
  if (!status) {
    return undefined;
  }
  return VALID_STATUSES.find((candidate) => candidate === status);
}

function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeStaffNameForMatch(value: string): string {
  return stripAccents(value).toUpperCase().replace(/[^A-ZΑ-Ω0-9]/g, '');
}

function normalizeCell(value: unknown): string {
  const text = readString(value);
  if (!text) {
    return '';
  }
  return stripAccents(text).toUpperCase().replace(/\s+/g, '').trim();
}

function staffCandidates(staff: ScheduleImportStaff): string[] {
  return [
    staff.id,
    staff.staffCode ?? '',
    staff.name ?? '',
    `${staff.firstName ?? ''} ${staff.lastName ?? ''}`,
    `${staff.lastName ?? ''} ${staff.firstName ?? ''}`,
    staff.firstName ?? '',
    staff.lastName ?? '',
  ];
}

function resolveStaffId(label: string | null, staffList?: ScheduleImportStaff[]): string | null {
  if (!label) {
    return null;
  }
  if (UUID_RE.test(label)) {
    return label;
  }
  if (!staffList || staffList.length === 0) {
    return null;
  }

  const target = normalizeStaffNameForMatch(label);
  if (!target) {
    return null;
  }

  for (const staff of staffList) {
    for (const candidate of staffCandidates(staff)) {
      const normalized = normalizeStaffNameForMatch(candidate);
      if (normalized && (normalized === target || normalized.includes(target) || target.includes(normalized))) {
        return staff.id;
      }
    }
  }

  return null;
}

function resolveStaffFromRow(row: Record<string, unknown>, ctx?: ScheduleImportContext): string | null {
  const direct = readString(row.staffId ?? row.staff_id ?? row['Staff ID']);
  const byDirect = resolveStaffId(direct, ctx?.staffList);
  if (byDirect) {
    return byDirect;
  }

  const candidates = [
    row.staffCode,
    row.staff_code,
    row['Staff Code'],
    row.staffName,
    row.staff_name,
    row['Staff Name'],
    row.Staff,
  ];
  for (const value of candidates) {
    const resolved = resolveStaffId(readString(value), ctx?.staffList);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

const DAY_MS = 86_400_000;
const PLAIN_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const TIME_ONLY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

interface WallClock {
  date: string;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

interface ResolvedInstant {
  iso: string;
  /** Read as a clock time on the row's date column. */
  timeOnly: boolean;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function validCalendarDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function validClock(hour: number, minute: number, second: number): boolean {
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 && second >= 0 && second < 60;
}

/** An Excel serial (days since the workbook epoch) as calendar parts, read in UTC. */
function excelSerialParts(serial: number, date1904: boolean): { date: string; seconds: number } {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const instant = new Date(epoch + Math.round(serial * 86_400) * 1000);
  return {
    date: instant.toISOString().slice(0, 10),
    seconds: instant.getUTCHours() * 3600 + instant.getUTCMinutes() * 60 + instant.getUTCSeconds(),
  };
}

function addCalendarDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar date a date column holds: `YYYY-MM-DD`, an Excel serial or a Date. */
function readDateHint(value: unknown, ctx?: BranchInstantContext): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 1 ? excelSerialParts(Math.floor(value), Boolean(ctx?.date1904)).date : null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : validCalendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  const text = readString(value);
  const match = text?.match(PLAIN_DATE_RE);
  return match ? validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function wallClockToIso(wall: WallClock, ctx: BranchInstantContext | undefined): string {
  const timeZone = ctx?.timeZone;
  if (!timeZone) {
    throw new Error('TIMEZONE_UNAVAILABLE');
  }
  const iso = branchWallTimeToIso(`${wall.date}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`, timeZone);
  return wall.millisecond ? new Date(Date.parse(iso) + wall.millisecond).toISOString() : iso;
}

function fractionToMilliseconds(fraction: string | undefined): number {
  return fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0;
}

/** Minutes east of UTC for `Z`, `+03`, `+0300` or `+03:00`; null when malformed. */
function offsetMinutes(zone: string): number | null {
  if (zone.toUpperCase() === 'Z') {
    return 0;
  }
  const match = zone.match(/^([+-])(\d{2}):?(\d{2})?$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

function wallFromSeconds(date: string, seconds: number): WallClock {
  return { date, hour: Math.floor(seconds / 3600), minute: Math.floor((seconds % 3600) / 60), second: seconds % 60, millisecond: 0 };
}

function resolveInstant(value: unknown, ctx: BranchInstantContext | undefined, dateHint: unknown): ResolvedInstant | null {
  const hintDate = () => readDateHint(dateHint, ctx);

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    if (value < 1) {
      // A time-only cell: a fraction of a day on the row's date.
      const date = hintDate();
      if (!date) {
        return null;
      }
      const seconds = Math.round(value * 86_400);
      if (seconds >= 86_400) {
        return null;
      }
      return { iso: wallClockToIso(wallFromSeconds(date, seconds), ctx), timeOnly: true };
    }
    const { date, seconds } = excelSerialParts(value, Boolean(ctx?.date1904));
    return { iso: wallClockToIso(wallFromSeconds(date, seconds), ctx), timeOnly: false };
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    const date = validCalendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    if (!date) {
      return null;
    }
    const wall = { date, hour: value.getHours(), minute: value.getMinutes(), second: value.getSeconds(), millisecond: value.getMilliseconds() };
    return { iso: wallClockToIso(wall, ctx), timeOnly: false };
  }

  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return null;
  }

  const dateTime = text.match(DATE_TIME_RE);
  if (dateTime) {
    const [, y, mo, d, h, mi, s, fraction, zone] = dateTime;
    const date = validCalendarDate(Number(y), Number(mo), Number(d));
    const hour = Number(h);
    const minute = Number(mi);
    const second = s ? Number(s) : 0;
    if (!date || !validClock(hour, minute, second)) {
      return null;
    }
    const millisecond = fractionToMilliseconds(fraction);
    if (zone) {
      const offset = offsetMinutes(zone);
      if (offset === null) {
        return null;
      }
      const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, minute, second, millisecond) - offset * 60_000;
      return { iso: new Date(utc).toISOString(), timeOnly: false };
    }
    return { iso: wallClockToIso({ date, hour, minute, second, millisecond }, ctx), timeOnly: false };
  }

  const timeOnly = text.match(TIME_ONLY_RE);
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    const second = timeOnly[3] ? Number(timeOnly[3]) : 0;
    const date = hintDate();
    if (!date || !validClock(hour, minute, second)) {
      return null;
    }
    return { iso: wallClockToIso({ date, hour, minute, second, millisecond: 0 }, ctx), timeOnly: true };
  }

  return null;
}

/**
 * One imported shift time as an instant (ISO, `Z`), read in the branch zone.
 *
 * - an Excel serial (days since 1899-12-30, or 1904-01-01 when the workbook
 *   says so) is a wall-clock time; below 1 it is a time on `dateHint`;
 * - `YYYY-MM-DD[ T]HH:MM[:SS[.f]]` without a zone is a branch wall-clock time;
 * - a value with `Z` or an offset is already an instant;
 * - a bare `HH:MM[:SS]` is a time on `dateHint` (the row's date column);
 * - a Date object counts by its wall-clock parts.
 *
 * Anything else returns null: the row is skipped, never sent raw. A branch
 * time without a branch zone throws `TIMEZONE_UNAVAILABLE`; a wall-clock time
 * inside a DST gap throws `BRANCH_TIME_INVALID`.
 */
export function toBranchInstant(value: unknown, ctx?: BranchInstantContext, dateHint?: unknown): string | null {
  return resolveInstant(value, ctx, dateHint)?.iso ?? null;
}

/**
 * A time after the shift start. A clock time read on the row's date that
 * falls before the start belongs to the next day (an overnight shift).
 */
function resolveAfterStart(
  value: unknown,
  ctx: RowsContext | undefined,
  dateHint: unknown,
  start: string,
): string | null {
  const resolved = resolveInstant(value, ctx, dateHint);
  if (!resolved) {
    return null;
  }
  if (!resolved.timeOnly || Date.parse(resolved.iso) >= Date.parse(start)) {
    return resolved.iso;
  }
  const date = readDateHint(dateHint, ctx);
  return date ? resolveInstant(value, ctx, addCalendarDays(date, 1))?.iso ?? null : null;
}

function rowsToShifts(rows: Array<Record<string, unknown>>, ctx?: RowsContext): RowsResult {
  const shifts: ImportedScheduleShift[] = [];
  let invalidRows = 0;

  for (const row of rows) {
    const staffId = resolveStaffFromRow(row, ctx);
    const startRaw = row.startTime ?? row.start_time ?? row['Start Time'];
    const endRaw = row.endTime ?? row.end_time ?? row['End Time'];
    if (!staffId || isBlank(startRaw) || isBlank(endRaw)) {
      continue;
    }

    const dateHint = row.date ?? row.Date ?? row.shift_date ?? row.shiftDate ?? row['Shift Date'];
    const startTime = resolveInstant(startRaw, ctx, dateHint)?.iso ?? null;
    const endTime = startTime ? resolveAfterStart(endRaw, ctx, dateHint, startTime) : null;
    const breakStartRaw = row.breakStart ?? row.break_start ?? row['Break Start'];
    const breakEndRaw = row.breakEnd ?? row.break_end ?? row['Break End'];
    const breakStart = startTime && !isBlank(breakStartRaw)
      ? resolveAfterStart(breakStartRaw, ctx, dateHint, startTime)
      : null;
    const breakEnd = startTime && !isBlank(breakEndRaw)
      ? resolveAfterStart(breakEndRaw, ctx, dateHint, startTime)
      : null;
    if (
      !startTime ||
      !endTime ||
      (!isBlank(breakStartRaw) && !breakStart) ||
      (!isBlank(breakEndRaw) && !breakEnd)
    ) {
      invalidRows += 1;
      continue;
    }

    const notesRaw = row.notes ?? row.Notes;

    shifts.push({
      staffId,
      startTime,
      endTime,
      breakStart,
      breakEnd,
      status: normalizeStatus(row.status ?? row.Status),
      notes: readString(notesRaw),
    });
  }

  return { shifts, invalidRows };
}

function extractMetaPayload(rawText: string, ctx?: ScheduleImportContext): RowsResult | null {
  const beginIdx = rawText.indexOf(META_BEGIN);
  const endIdx = rawText.indexOf(META_END, beginIdx + META_BEGIN.length);
  if (beginIdx === -1 || endIdx === -1) {
    return null;
  }

  let inner = rawText.slice(beginIdx + META_BEGIN.length, endIdx);
  inner = inner.replace(/\s+/g, '').trim();
  const start = inner.indexOf('{');
  const end = inner.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return null;
  }

  let parsed: { shifts?: unknown };
  try {
    parsed = JSON.parse(inner.slice(start, end + 1)) as { shifts?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.shifts)) {
    return null;
  }
  // Time errors (no branch zone, DST gap) reach the operator, as in a spreadsheet.
  return rowsToShifts(parsed.shifts as Array<Record<string, unknown>>, ctx);
}

const NO_ROWS: RowsResult = { shifts: [], invalidRows: 0 };

async function parseJSONFile(file: File, ctx?: ScheduleImportContext): Promise<RowsResult> {
  const parsed = JSON.parse(await file.text()) as { shifts?: unknown };
  if (!Array.isArray(parsed?.shifts)) {
    return NO_ROWS;
  }
  return rowsToShifts(parsed.shifts as Array<Record<string, unknown>>, ctx);
}

async function parseCSVFile(file: File, ctx?: ScheduleImportContext): Promise<RowsResult> {
  const Papa = (await import('papaparse')).default;
  const result = Papa.parse<Record<string, unknown>>(await file.text(), {
    header: true,
    skipEmptyLines: true,
  });
  return rowsToShifts(result.data, ctx);
}

function isDayHeaderRow(row: unknown[]): { match: boolean; map: Map<number, number> } {
  const map = new Map<number, number>();
  for (let i = 0; i < row.length; i += 1) {
    const key = normalizeCell(row[i]);
    if (key in DAY_KEYWORDS) {
      map.set(i, DAY_KEYWORDS[key]);
    }
  }
  return { match: map.size >= 3, map };
}

function isOffMarker(value: unknown): boolean {
  const key = normalizeCell(value);
  return !key || OFF_MARKERS.has(key);
}

function parseTimeRangeCell(
  value: unknown,
): { sH: number; sM: number; eH: number; eM: number; startNextDay: boolean; crossesMidnight: boolean } | null {
  const text = readString(value);
  if (!text) {
    return null;
  }
  const match = text.replace(/\s+/g, '').match(/^(\d{1,2}):?(\d{2})?[-–—](\d{1,2}):?(\d{2})?$/);
  if (!match) {
    return null;
  }

  let sH = parseInt(match[1], 10);
  const sM = match[2] ? parseInt(match[2], 10) : 0;
  let eH = parseInt(match[3], 10);
  const eM = match[4] ? parseInt(match[4], 10) : 0;
  if (Number.isNaN(sH) || Number.isNaN(eH)) {
    return null;
  }

  let startNextDay = false;
  if (sH >= 24) {
    sH -= 24;
    startNextDay = true;
  }
  if (eH >= 24) {
    eH -= 24;
  }

  const crossesMidnight = eH < sH || (eH === sH && eM < sM);
  return { sH, sM, eH, eM, startNextDay, crossesMidnight };
}

function resolveDatesForMatrix(
  rows: unknown[][],
  dayMap: Map<number, number>,
  dayHeaderRowIdx: number,
  timeZone: string,
): Map<number, Date> {
  const result = new Map<number, Date>();

  for (let rowIdx = Math.max(0, dayHeaderRowIdx - 2); rowIdx < dayHeaderRowIdx; rowIdx += 1) {
    const row = rows[rowIdx];
    if (!row) {
      continue;
    }
    for (const colIdx of dayMap.keys()) {
      const cell = row[colIdx];
      if (typeof cell === 'number' && cell > 25000 && cell < 80000) {
        result.set(colIdx, new Date((cell - 25569) * 86400 * 1000));
      } else if (typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}/.test(cell)) {
        result.set(colIdx, new Date(`${cell.slice(0, 10)}T00:00:00Z`));
      }
    }
    if (result.size === dayMap.size) {
      return result;
    }
  }

  const today = new Date(`${branchWallTime(new Date(), timeZone).slice(0, 10)}T00:00:00Z`);
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));

  for (const [colIdx, weekday] of dayMap.entries()) {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + ((weekday + 6) % 7));
    result.set(colIdx, date);
  }
  return result;
}

function buildISO(date: Date, hour: number, minute: number, addDays: number, timeZone: string): string {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + addDays);
  next.setUTCHours(hour, minute, 0, 0);
  return branchWallTimeToIso(next.toISOString().slice(0, 19), timeZone);
}

function parseMatrixBlock(
  rows: unknown[][],
  dayHeaderRowIdx: number,
  dayMap: Map<number, number>,
  ctx: ScheduleImportContext | undefined,
  blockEndIdx: number,
): { shifts: ImportedScheduleShift[]; unmatched: Set<string> } {
  if (!ctx?.timeZone) throw new Error('TIMEZONE_UNAVAILABLE');
  const dates = resolveDatesForMatrix(rows, dayMap, dayHeaderRowIdx, ctx.timeZone);
  const shifts: ImportedScheduleShift[] = [];
  const unmatched = new Set<string>();

  for (let rowIdx = dayHeaderRowIdx + 1; rowIdx < blockEndIdx; rowIdx += 1) {
    const row = rows[rowIdx] || [];
    let label = '';
    for (let colIdx = 0; colIdx < row.length; colIdx += 1) {
      if (dayMap.has(colIdx)) {
        break;
      }
      const value = readString(row[colIdx]);
      if (value) {
        label = value;
        break;
      }
    }
    if (!label) {
      continue;
    }

    const staffId = resolveStaffId(label, ctx?.staffList);
    if (!staffId) {
      unmatched.add(label);
      continue;
    }

    for (const [colIdx, weekday] of dayMap.entries()) {
      const cell = row[colIdx];
      if (isOffMarker(cell)) {
        continue;
      }
      const parsed = parseTimeRangeCell(cell);
      const baseDate = dates.get(colIdx);
      if (!parsed || !baseDate) {
        continue;
      }
      const startTime = buildISO(baseDate, parsed.sH, parsed.sM, parsed.startNextDay ? 1 : 0, ctx.timeZone);
      const endTime = buildISO(
        baseDate,
        parsed.eH,
        parsed.eM,
        (parsed.startNextDay ? 1 : 0) + (parsed.crossesMidnight ? 1 : 0),
        ctx.timeZone,
      );
      shifts.push({
        staffId,
        startTime,
        endTime,
        breakStart: null,
        breakEnd: null,
        notes: `imported: ${label} - ${String(cell)} - weekday=${weekday}`,
      });
    }
  }

  return { shifts, unmatched };
}

function parseMatrixSheet(rows: unknown[][], ctx?: ScheduleImportContext): { shifts: ImportedScheduleShift[]; unmatched: string[] } {
  const headers: Array<{ idx: number; map: Map<number, number> }> = [];
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx += 1) {
    const probe = isDayHeaderRow(rows[rowIdx] || []);
    if (probe.match) {
      headers.push({ idx: rowIdx, map: probe.map });
    }
  }
  if (headers.length === 0) {
    return { shifts: [], unmatched: [] };
  }

  const allShifts: ImportedScheduleShift[] = [];
  const allUnmatched = new Set<string>();
  for (let i = 0; i < headers.length; i += 1) {
    const block = headers[i];
    const endIdx = i + 1 < headers.length ? headers[i + 1].idx : rows.length;
    const { shifts, unmatched } = parseMatrixBlock(rows, block.idx, block.map, ctx, endIdx);
    shifts.forEach((shift) => allShifts.push(shift));
    unmatched.forEach((name) => allUnmatched.add(name));
  }

  return { shifts: allShifts, unmatched: [...allUnmatched] };
}

async function parseXLSXFile(
  file: File,
  ctx?: ScheduleImportContext,
): Promise<{ shifts: ImportedScheduleShift[]; unmatched: string[]; invalidRows: number }> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

  if (firstSheet) {
    // Raw cells: dates and times arrive as Excel serial numbers, read in the
    // branch zone with the workbook's own date system.
    const fromColumns = rowsToShifts(XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet), {
      ...ctx,
      date1904: Boolean(workbook.Workbook?.WBProps?.date1904),
    });
    if (fromColumns.shifts.length > 0 || fromColumns.invalidRows > 0) {
      return { shifts: fromColumns.shifts, unmatched: [], invalidRows: fromColumns.invalidRows };
    }
  }

  const allShifts: ImportedScheduleShift[] = [];
  const allUnmatched = new Set<string>();
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
    const { shifts, unmatched } = parseMatrixSheet(rows, ctx);
    shifts.forEach((shift) => allShifts.push(shift));
    unmatched.forEach((name) => allUnmatched.add(name));
  }

  return { shifts: allShifts, unmatched: [...allUnmatched], invalidRows: 0 };
}

/** The IANA zone an ICS `TZID` names, or null when this runtime does not know it. */
function icsZone(params: string): string | null | undefined {
  const match = params.match(/;TZID=([^;:]+)/i);
  if (!match) {
    return undefined;
  }
  const zone = match[1].trim().replace(/^"(.*)"$/, '$1');
  try {
    branchWallTime(new Date(0), zone);
    return zone;
  } catch {
    return null;
  }
}

/** An ICS date-time (`YYYYMMDDTHHMMSS[Z]`, local to its `TZID` or floating). */
function icsInstant(property: { params: string; value: string } | null, ctx?: ScheduleImportContext): string | null {
  if (!property || /;VALUE=DATE(?![-\w])/i.test(property.params)) {
    return null;
  }
  const match = property.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, sec, z] = match;
  const text = `${y}-${mo}-${d}T${h}:${mi}:${sec}${z ? 'Z' : ''}`;
  if (z) {
    return toBranchInstant(text);
  }
  const zone = icsZone(property.params);
  if (zone === null) {
    // A zone this till cannot read: never guess another one.
    return null;
  }
  return toBranchInstant(text, { timeZone: zone ?? ctx?.timeZone });
}

async function parseICSFile(file: File, ctx?: ScheduleImportContext): Promise<RowsResult> {
  const text = await file.text();
  const shifts: ImportedScheduleShift[] = [];
  let invalidRows = 0;
  const blocks = text.split(/BEGIN:VEVENT/i).slice(1);

  for (const block of blocks) {
    const segment = block.split(/END:VEVENT/i)[0] ?? '';
    const property = (key: string) => {
      const match = segment.match(new RegExp(`(?:^|[\r\n])${key}([^:\r\n]*):([^\r\n]+)`, 'i'));
      return match ? { params: match[1], value: match[2].trim() } : null;
    };
    const get = (key: string) => property(key)?.value ?? null;
    const dtstart = property('DTSTART');
    const dtend = property('DTEND');
    if (!dtstart || !dtend) {
      continue;
    }

    const staffLabel = (get('SUMMARY') || '').replace(/^Shift:\s*/i, '').trim();
    const staffId = resolveStaffId(staffLabel, ctx?.staffList);
    if (!staffId) {
      continue;
    }
    const startTime = icsInstant(dtstart, ctx);
    const endTime = icsInstant(dtend, ctx);
    if (!startTime || !endTime) {
      invalidRows += 1;
      continue;
    }
    shifts.push({
      staffId,
      startTime,
      endTime,
      breakStart: null,
      breakEnd: null,
      notes: readString(get('DESCRIPTION')),
    });
  }

  return { shifts, invalidRows };
}

async function parseTXTFile(file: File, ctx?: ScheduleImportContext): Promise<RowsResult> {
  return extractMetaPayload(await file.text(), ctx) ?? NO_ROWS;
}

async function parseDOCXFile(file: File, ctx?: ScheduleImportContext): Promise<RowsResult> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return extractMetaPayload(result.value, ctx) ?? NO_ROWS;
}

async function parsePDFFile(file: File, ctx?: ScheduleImportContext): Promise<RowsResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  (pdfjs as { GlobalWorkerOptions?: { workerSrc?: string } }).GlobalWorkerOptions = {
    ...(pdfjs as { GlobalWorkerOptions?: { workerSrc?: string } }).GlobalWorkerOptions,
    workerSrc: '',
  };
  const loadingTask = (pdfjs as unknown as {
    getDocument: (params: { data: ArrayBuffer; disableWorker?: boolean }) => { promise: Promise<unknown> };
  }).getDocument({ data: await file.arrayBuffer(), disableWorker: true });
  const document = (await loadingTask.promise) as {
    numPages: number;
    getPage: (pageNumber: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }>;
  };
  const chunks: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    chunks.push(textContent.items.map((item) => item.str ?? '').join(' '));
  }
  return extractMetaPayload(chunks.join('\n'), ctx) ?? NO_ROWS;
}

function rowsResult(format: ScheduleImportResult['format'], rows: RowsResult): ScheduleImportResult {
  return { shifts: rows.shifts, format, invalidRows: rows.invalidRows };
}

export async function importStaffScheduleFile(file: File, ctx?: ScheduleImportContext): Promise<ScheduleImportResult> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) {
    return rowsResult('json', await parseJSONFile(file, ctx));
  }
  if (name.endsWith('.csv')) {
    return rowsResult('csv', await parseCSVFile(file, ctx));
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const result = await parseXLSXFile(file, ctx);
    return {
      shifts: result.shifts,
      format: 'xlsx',
      unmatchedStaffLabels: result.unmatched,
      invalidRows: result.invalidRows,
    };
  }
  if (name.endsWith('.ics')) {
    return rowsResult('ics', await parseICSFile(file, ctx));
  }
  if (name.endsWith('.pdf')) {
    return rowsResult('pdf', await parsePDFFile(file, ctx));
  }
  if (name.endsWith('.docx') || name.endsWith('.doc')) {
    return rowsResult('docx', await parseDOCXFile(file, ctx));
  }
  if (name.endsWith('.txt')) {
    return rowsResult('txt', await parseTXTFile(file, ctx));
  }

  try {
    return rowsResult('json', await parseJSONFile(file, ctx));
  } catch (jsonError) {
    // Only an unreadable JSON file falls back; a time error reaches the operator.
    if (!(jsonError instanceof SyntaxError)) {
      throw jsonError;
    }
    try {
      return rowsResult('csv', await parseCSVFile(file, ctx));
    } catch (csvError) {
      if (csvError instanceof Error && ['TIMEZONE_UNAVAILABLE', 'BRANCH_TIME_INVALID'].includes(csvError.message)) {
        throw csvError;
      }
      return { shifts: [], format: null };
    }
  }
}
