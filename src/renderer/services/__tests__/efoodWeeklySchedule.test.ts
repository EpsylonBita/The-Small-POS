import { describe, expect, it } from 'vitest'
import {
  EFOOD_WEEK_DAYS,
  efoodDraftDaysEqual,
  efoodWeeklySchedulesEqual,
  extractEfoodScheduleErrorCode,
  makeClosedEfoodWeek,
  parseEfoodInterval,
  validateEfoodWeeklySchedule,
  type EfoodDaySchedule,
} from '../efoodWeeklySchedule'

function withTimes(day: string, times: string[]): EfoodDaySchedule[] {
  return EFOOD_WEEK_DAYS.map((d) => ({ day: d, times: d === day ? times : [] }))
}

describe('parseEfoodInterval', () => {
  it('accepts a normal interval', () => {
    expect(parseEfoodInterval('08:00-16:00')).toMatchObject({ start: '08:00', end: '16:00' })
  })

  it('accepts 23:59 as an end (canonical closing time)', () => {
    expect(parseEfoodInterval('00:00-23:59')).toMatchObject({ start: '00:00', end: '23:59' })
  })

  it('rejects the legacy 24:00 marker as either start or end', () => {
    expect(parseEfoodInterval('00:00-24:00')).toBeNull()
    expect(parseEfoodInterval('24:00-08:00')).toBeNull()
  })

  it.each(['8:00-16:00', '08:00-16:0', 'ab:00-16:00', '08:00', '16:00-08:00', '10:00-10:00'])(
    'rejects malformed or non-positive interval %s',
    (interval) => {
      expect(parseEfoodInterval(interval)).toBeNull()
    },
  )
})

describe('validateEfoodWeeklySchedule', () => {
  it('accepts a full week with closed and split days', () => {
    const days = EFOOD_WEEK_DAYS.map((day) => ({
      day,
      times: day === 'sunday' ? [] : ['08:00-12:00', '13:00-16:00'],
    }))
    expect(validateEfoodWeeklySchedule(days)).toEqual({ valid: true })
  })

  it('accepts an all-day interval', () => {
    expect(validateEfoodWeeklySchedule(withTimes('monday', ['00:00-23:59']))).toEqual({ valid: true })
  })

  it('rejects the legacy 24:00 marker', () => {
    expect(validateEfoodWeeklySchedule(withTimes('monday', ['00:00-24:00'])).valid).toBe(false)
  })

  it('rejects a missing day', () => {
    const days = EFOOD_WEEK_DAYS.slice(0, 6).map((day) => ({ day, times: [] }))
    expect(validateEfoodWeeklySchedule(days).valid).toBe(false)
  })

  it('rejects a duplicate day', () => {
    const days = EFOOD_WEEK_DAYS.map((day) => ({ day: day === 'tuesday' ? 'monday' : day, times: [] }))
    const result = validateEfoodWeeklySchedule(days as EfoodDaySchedule[])
    expect(result.valid).toBe(false)
    expect(result.error).toBe('duplicate_day')
  })

  it('rejects an invalid interval', () => {
    const result = validateEfoodWeeklySchedule(withTimes('friday', ['9am-5pm']))
    expect(result).toEqual({ valid: false, error: 'invalid_interval', invalidDay: 'friday' })
  })

  it('rejects overlapping intervals', () => {
    const result = validateEfoodWeeklySchedule(withTimes('wednesday', ['08:00-14:00', '13:00-18:00']))
    expect(result).toEqual({ valid: false, error: 'overlapping_intervals', invalidDay: 'wednesday' })
  })

  it('accepts multiple adjacent (touching) ranges', () => {
    const result = validateEfoodWeeklySchedule(withTimes('thursday', ['08:00-12:00', '12:00-16:00']))
    expect(result).toEqual({ valid: true })
  })

  it.each([
    ['not an array', 'a string'],
    ['null', null],
    ['undefined', undefined],
    ['wrong length', EFOOD_WEEK_DAYS.slice(0, 3).map((day) => ({ day, times: [] }))],
  ])('fails closed instead of throwing for %s', (_label, input) => {
    expect(() => validateEfoodWeeklySchedule(input)).not.toThrow()
    expect(validateEfoodWeeklySchedule(input).valid).toBe(false)
  })

  it('fails closed instead of throwing on null/primitive day entries', () => {
    const days = [null, 42, 'monday', 'tuesday', 'wednesday', 'thursday', 'friday']
    expect(() => validateEfoodWeeklySchedule(days)).not.toThrow()
    expect(validateEfoodWeeklySchedule(days)).toEqual({ valid: false, error: 'missing_days' })
  })

  it('fails closed instead of throwing on a non-string day field', () => {
    const days = EFOOD_WEEK_DAYS.map((day) => ({ day: day === 'monday' ? 7 : day, times: [] }))
    expect(() => validateEfoodWeeklySchedule(days)).not.toThrow()
    expect(validateEfoodWeeklySchedule(days).valid).toBe(false)
  })

  it('fails closed instead of throwing on non-array or non-string times', () => {
    const daysNonArray = EFOOD_WEEK_DAYS.map((day) => ({ day, times: day === 'monday' ? 'not-an-array' : [] }))
    expect(() => validateEfoodWeeklySchedule(daysNonArray)).not.toThrow()
    expect(validateEfoodWeeklySchedule(daysNonArray).valid).toBe(false)

    const daysNonStringTime = EFOOD_WEEK_DAYS.map((day) => ({ day, times: day === 'monday' ? [42] : [] }))
    expect(() => validateEfoodWeeklySchedule(daysNonStringTime)).not.toThrow()
    expect(validateEfoodWeeklySchedule(daysNonStringTime).valid).toBe(false)
  })
})

describe('efoodDraftDaysEqual', () => {
  it('is order-sensitive and does not filter invalid/incomplete intervals', () => {
    const a = withTimes('monday', ['08:00-12:00', ''])
    const b = withTimes('monday', ['08:00-12:00'])
    // "b" has no second (blank) interval at all: raw comparison must see this
    // as a change even though the blank entry does not parse.
    expect(efoodDraftDaysEqual(a, b)).toBe(false)
    expect(efoodDraftDaysEqual(a, a)).toBe(true)
  })

  it('treats a different interval order as a change (unlike the semantic comparison)', () => {
    const a = withTimes('monday', ['08:00-12:00', '13:00-16:00'])
    const b = withTimes('monday', ['13:00-16:00', '08:00-12:00'])
    expect(efoodDraftDaysEqual(a, b)).toBe(false)
    expect(efoodWeeklySchedulesEqual(a, b)).toBe(true)
  })
})

describe('efoodWeeklySchedulesEqual', () => {
  it('is true for the same schedule in a different day/interval order', () => {
    const a = EFOOD_WEEK_DAYS.map((day) => ({ day, times: day === 'monday' ? ['08:00-12:00', '13:00-16:00'] : [] }))
    const b = [...a].reverse().map((entry) =>
      entry.day === 'monday' ? { ...entry, times: ['13:00-16:00', '08:00-12:00'] } : entry,
    )
    expect(efoodWeeklySchedulesEqual(a, b)).toBe(true)
  })

  it('is false when an interval differs', () => {
    const a = withTimes('monday', ['08:00-12:00'])
    const b = withTimes('monday', ['08:00-13:00'])
    expect(efoodWeeklySchedulesEqual(a, b)).toBe(false)
  })

  it('makeClosedEfoodWeek yields all seven days closed', () => {
    const closed = makeClosedEfoodWeek()
    expect(closed).toHaveLength(7)
    expect(closed.every((entry) => entry.times.length === 0)).toBe(true)
  })
})

describe('extractEfoodScheduleErrorCode', () => {
  it.each([
    ['provider_forbidden', 'provider_forbidden'],
    ['provider_forbidden (HTTP 502)', 'provider_forbidden'],
    ['provider_forbidden (HTTP 502): upstream refusal', 'provider_forbidden'],
    ['invalid_schedule (HTTP 400): bad request', 'invalid_schedule'],
    ['MODULE_REQUIRED (HTTP 403)', 'MODULE_REQUIRED'],
  ])('recognizes %s as %s', (input, code) => {
    expect(extractEfoodScheduleErrorCode(input)).toBe(code)
  })

  it.each(['ECONNRESET raw provider failure', '<!doctype html>upstream failure', 'random text', null, undefined])(
    'treats unrecognized/absent errors as unmapped: %s',
    (input) => {
      expect(extractEfoodScheduleErrorCode(input as string | null | undefined)).toBeNull()
    },
  )
})
