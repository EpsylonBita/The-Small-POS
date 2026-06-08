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
}

export interface ScheduleImportResult {
  shifts: ImportedScheduleShift[];
  format: 'json' | 'csv' | 'xlsx' | 'ics' | 'pdf' | 'docx' | 'txt' | null;
  unmatchedStaffLabels?: string[];
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

function rowsToShifts(rows: Array<Record<string, unknown>>, ctx?: ScheduleImportContext): ImportedScheduleShift[] {
  const shifts: ImportedScheduleShift[] = [];

  for (const row of rows) {
    const staffId = resolveStaffFromRow(row, ctx);
    const startTime = readString(row.startTime ?? row.start_time ?? row['Start Time']);
    const endTime = readString(row.endTime ?? row.end_time ?? row['End Time']);
    if (!staffId || !startTime || !endTime) {
      continue;
    }

    const breakStartRaw = row.breakStart ?? row.break_start ?? row['Break Start'];
    const breakEndRaw = row.breakEnd ?? row.break_end ?? row['Break End'];
    const notesRaw = row.notes ?? row.Notes;

    shifts.push({
      staffId,
      startTime,
      endTime,
      breakStart: readString(breakStartRaw),
      breakEnd: readString(breakEndRaw),
      status: normalizeStatus(row.status ?? row.Status),
      notes: readString(notesRaw),
    });
  }

  return shifts;
}

function extractMetaPayload(rawText: string, ctx?: ScheduleImportContext): ImportedScheduleShift[] | null {
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

  try {
    const parsed = JSON.parse(inner.slice(start, end + 1)) as { shifts?: unknown };
    if (!Array.isArray(parsed?.shifts)) {
      return null;
    }
    return rowsToShifts(parsed.shifts as Array<Record<string, unknown>>, ctx);
  } catch {
    return null;
  }
}

async function parseJSONFile(file: File, ctx?: ScheduleImportContext): Promise<ImportedScheduleShift[]> {
  const parsed = JSON.parse(await file.text()) as { shifts?: unknown };
  if (!Array.isArray(parsed?.shifts)) {
    return [];
  }
  return rowsToShifts(parsed.shifts as Array<Record<string, unknown>>, ctx);
}

async function parseCSVFile(file: File, ctx?: ScheduleImportContext): Promise<ImportedScheduleShift[]> {
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
        result.set(colIdx, new Date(cell));
      }
    }
    if (result.size === dayMap.size) {
      return result;
    }
  }

  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);

  for (const [colIdx, weekday] of dayMap.entries()) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + ((weekday + 6) % 7));
    result.set(colIdx, date);
  }
  return result;
}

function buildISO(date: Date, hour: number, minute: number, addDays: number): string {
  const next = new Date(date);
  next.setDate(next.getDate() + addDays);
  next.setHours(hour, minute, 0, 0);
  return next.toISOString();
}

function parseMatrixBlock(
  rows: unknown[][],
  dayHeaderRowIdx: number,
  dayMap: Map<number, number>,
  ctx: ScheduleImportContext | undefined,
  blockEndIdx: number,
): { shifts: ImportedScheduleShift[]; unmatched: Set<string> } {
  const dates = resolveDatesForMatrix(rows, dayMap, dayHeaderRowIdx);
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
      const startTime = buildISO(baseDate, parsed.sH, parsed.sM, parsed.startNextDay ? 1 : 0);
      const endTime = buildISO(
        baseDate,
        parsed.eH,
        parsed.eM,
        (parsed.startNextDay ? 1 : 0) + (parsed.crossesMidnight ? 1 : 0),
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
): Promise<{ shifts: ImportedScheduleShift[]; unmatched: string[] }> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

  if (firstSheet) {
    const fromColumns = rowsToShifts(XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet), ctx);
    if (fromColumns.length > 0) {
      return { shifts: fromColumns, unmatched: [] };
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

  return { shifts: allShifts, unmatched: [...allUnmatched] };
}

async function parseICSFile(file: File, ctx?: ScheduleImportContext): Promise<ImportedScheduleShift[]> {
  const text = await file.text();
  const shifts: ImportedScheduleShift[] = [];
  const blocks = text.split(/BEGIN:VEVENT/i).slice(1);

  for (const block of blocks) {
    const segment = block.split(/END:VEVENT/i)[0] ?? '';
    const get = (key: string) => {
      const match = segment.match(new RegExp(`${key}[^:\n]*:([^\n\r]+)`, 'i'));
      return match ? match[1].trim() : null;
    };
    const dtstart = get('DTSTART');
    const dtend = get('DTEND');
    if (!dtstart || !dtend) {
      continue;
    }

    const toISO = (raw: string) => {
      const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
      if (!match) {
        return null;
      }
      const [, y, mo, d, h, mi, s, z] = match;
      return `${y}-${mo}-${d}T${h}:${mi}:${s}${z || ''}`;
    };
    const startTime = toISO(dtstart);
    const endTime = toISO(dtend);
    const staffLabel = (get('SUMMARY') || '').replace(/^Shift:\s*/i, '').trim();
    const staffId = resolveStaffId(staffLabel, ctx?.staffList);
    if (!startTime || !endTime || !staffId) {
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

  return shifts;
}

async function parseTXTFile(file: File, ctx?: ScheduleImportContext): Promise<ImportedScheduleShift[]> {
  return extractMetaPayload(await file.text(), ctx) ?? [];
}

async function parseDOCXFile(file: File, ctx?: ScheduleImportContext): Promise<ImportedScheduleShift[]> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return extractMetaPayload(result.value, ctx) ?? [];
}

async function parsePDFFile(file: File, ctx?: ScheduleImportContext): Promise<ImportedScheduleShift[]> {
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
  return extractMetaPayload(chunks.join('\n'), ctx) ?? [];
}

export async function importStaffScheduleFile(file: File, ctx?: ScheduleImportContext): Promise<ScheduleImportResult> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) {
    return { shifts: await parseJSONFile(file, ctx), format: 'json' };
  }
  if (name.endsWith('.csv')) {
    return { shifts: await parseCSVFile(file, ctx), format: 'csv' };
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const result = await parseXLSXFile(file, ctx);
    return { shifts: result.shifts, format: 'xlsx', unmatchedStaffLabels: result.unmatched };
  }
  if (name.endsWith('.ics')) {
    return { shifts: await parseICSFile(file, ctx), format: 'ics' };
  }
  if (name.endsWith('.pdf')) {
    return { shifts: await parsePDFFile(file, ctx), format: 'pdf' };
  }
  if (name.endsWith('.docx') || name.endsWith('.doc')) {
    return { shifts: await parseDOCXFile(file, ctx), format: 'docx' };
  }
  if (name.endsWith('.txt')) {
    return { shifts: await parseTXTFile(file, ctx), format: 'txt' };
  }

  try {
    return { shifts: await parseJSONFile(file, ctx), format: 'json' };
  } catch {
    try {
      return { shifts: await parseCSVFile(file, ctx), format: 'csv' };
    } catch {
      return { shifts: [], format: null };
    }
  }
}
