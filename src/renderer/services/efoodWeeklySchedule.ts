// Pure helpers for the efood weekly hours editor. No admin-dashboard imports:
// this module only knows the flat POS route contract described in the spec.

export type EfoodWeekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday'

export const EFOOD_WEEK_DAYS: readonly EfoodWeekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]

export interface EfoodDaySchedule {
  day: EfoodWeekday
  times: string[]
}

export interface EfoodWeeklySchedule {
  days: EfoodDaySchedule[]
}

// Closing time is canonically 23:59, never the legacy "24:00" midnight
// marker (see admin-dashboard/src/lib/plugins/efood/weekly-schedule.ts).
export const EFOOD_ALL_DAY_INTERVAL = '00:00-23:59'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function toMinutes(time: string): number | null {
  const match = TIME_RE.exec(time)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

export interface EfoodIntervalParsed {
  start: string
  end: string
  startMinutes: number
  endMinutes: number
}

/** Returns null when the interval string is not `HH:mm-HH:mm` with a valid end (23:59 max, never 24:00). */
export function parseEfoodInterval(interval: string): EfoodIntervalParsed | null {
  if (typeof interval !== 'string') return null
  const parts = interval.split('-')
  if (parts.length !== 2) return null
  const [start, end] = parts
  const startMinutes = toMinutes(start)
  const endMinutes = toMinutes(end)
  if (startMinutes === null || endMinutes === null) return null
  if (endMinutes <= startMinutes) return null
  return { start, end, startMinutes, endMinutes }
}

export type EfoodScheduleValidationError =
  | 'missing_days'
  | 'duplicate_day'
  | 'invalid_interval'
  | 'overlapping_intervals'

export interface EfoodScheduleValidationResult {
  valid: boolean
  error?: EfoodScheduleValidationError
  invalidDay?: EfoodWeekday
}

/**
 * Validates the exact wire contract: all 7 unique Monday-first days, HH:mm
 * intervals, end>start, no overlaps. Accepts `unknown` because this also
 * gates untrusted upstream/provider JSON: malformed shapes (null entries,
 * non-string days, non-array times) must fail closed, never throw.
 */
export function validateEfoodWeeklySchedule(days: unknown): EfoodScheduleValidationResult {
  if (!Array.isArray(days) || days.length !== EFOOD_WEEK_DAYS.length) {
    return { valid: false, error: 'missing_days' }
  }

  const seen = new Set<string>()
  for (const entry of days) {
    if (!entry || typeof entry !== 'object' || typeof (entry as { day?: unknown }).day !== 'string') {
      return { valid: false, error: 'missing_days' }
    }
    const day = (entry as { day: string }).day
    if (!EFOOD_WEEK_DAYS.includes(day as EfoodWeekday) || seen.has(day)) {
      return { valid: false, error: 'duplicate_day', invalidDay: EFOOD_WEEK_DAYS.includes(day as EfoodWeekday) ? (day as EfoodWeekday) : undefined }
    }
    seen.add(day)
  }
  if (seen.size !== EFOOD_WEEK_DAYS.length) {
    return { valid: false, error: 'missing_days' }
  }

  for (const entry of days as Array<{ day: EfoodWeekday; times: unknown }>) {
    if (!Array.isArray(entry.times)) {
      return { valid: false, error: 'invalid_interval', invalidDay: entry.day }
    }
    const parsed = entry.times.map((interval) =>
      typeof interval === 'string' ? parseEfoodInterval(interval) : null,
    )
    if (parsed.some((interval) => interval === null)) {
      return { valid: false, error: 'invalid_interval', invalidDay: entry.day }
    }
    const sorted = (parsed as EfoodIntervalParsed[]).slice().sort((a, b) => a.startMinutes - b.startMinutes)
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].startMinutes < sorted[i - 1].endMinutes) {
        return { valid: false, error: 'overlapping_intervals', invalidDay: entry.day }
      }
    }
  }

  return { valid: true }
}

function normalizeDayForCompare(entry: EfoodDaySchedule): string {
  const parsed = entry.times
    .map(parseEfoodInterval)
    .filter((interval): interval is EfoodIntervalParsed => interval !== null)
    .sort((a, b) => a.startMinutes - b.startMinutes)
    .map((interval) => `${interval.start}-${interval.end}`)
  return `${entry.day}:${parsed.join(',')}`
}

/** Order/whitespace-insensitive comparison of two 7-day schedules by normalized intervals. */
export function efoodWeeklySchedulesEqual(a: EfoodDaySchedule[], b: EfoodDaySchedule[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  const normalize = (days: EfoodDaySchedule[]) =>
    days
      .slice()
      .sort((x, y) => EFOOD_WEEK_DAYS.indexOf(x.day) - EFOOD_WEEK_DAYS.indexOf(y.day))
      .map(normalizeDayForCompare)
      .join('|')
  return normalize(a) === normalize(b)
}

/**
 * Exact, order-sensitive comparison of raw (possibly incomplete/invalid) draft
 * input, used only for dirty-tracking. Unlike `efoodWeeklySchedulesEqual` this
 * never filters out unparsable intervals, so an edit that is not yet a valid
 * time (e.g. a newly added blank interval) is still detected as a change and
 * is never silently discarded by a background refresh.
 */
export function efoodDraftDaysEqual(a: EfoodDaySchedule[], b: EfoodDaySchedule[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].day !== b[i].day) return false
    const at = a[i].times
    const bt = b[i].times
    if (at.length !== bt.length) return false
    for (let j = 0; j < at.length; j += 1) {
      if (at[j] !== bt[j]) return false
    }
  }
  return true
}

export function sortEfoodDays(days: EfoodDaySchedule[]): EfoodDaySchedule[] {
  return days
    .slice()
    .sort((a, b) => EFOOD_WEEK_DAYS.indexOf(a.day) - EFOOD_WEEK_DAYS.indexOf(b.day))
}

export function makeClosedEfoodWeek(): EfoodDaySchedule[] {
  return EFOOD_WEEK_DAYS.map((day) => ({ day, times: [] }))
}

export type EfoodScheduleErrorCode =
  | 'provider_forbidden'
  | 'invalid_schedule'
  | 'provider_unavailable'
  | 'outcome_unknown'
  | 'production_not_connected'
  | 'wrong_terminal'
  | 'module_disabled'
  | 'MODULE_REQUIRED'

const EFOOD_SCHEDULE_ERROR_CODES: ReadonlySet<string> = new Set([
  'provider_forbidden',
  'invalid_schedule',
  'provider_unavailable',
  'outcome_unknown',
  'production_not_connected',
  'wrong_terminal',
  'module_disabled',
  'MODULE_REQUIRED',
])

// The Tauri IPC transport wraps a backend error marker as "code (HTTP nnn): ...".
// Only a recognized, exact-matching code is ever surfaced; anything else (including
// raw provider text) must fall back to a generic "outcome unknown" message.
export function extractEfoodScheduleErrorCode(error?: string | null): EfoodScheduleErrorCode | null {
  if (typeof error !== 'string') return null
  const match = /^([A-Za-z_]+)(?:$| \(HTTP \d+\)(?::|$))/.exec(error.trim())
  const code = match?.[1]
  return code && EFOOD_SCHEDULE_ERROR_CODES.has(code) ? (code as EfoodScheduleErrorCode) : null
}
