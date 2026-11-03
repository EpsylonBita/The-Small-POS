import { renderHook, act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkCardStatus, parseWorkCardStatus, createWorkCardCache, workCardStaffBatches, workCardLineKey, WORK_CARD_MAX_AGE_MS, WORK_CARD_TIMEOUT_MS, type WorkCardStaff } from '../useWorkCardStatus'
import { workCardOpenShiftsHintKey } from '../../utils/unit-shift-readiness'
const mocks = vi.hoisted(() => ({ get: vi.fn(), scope: 'main' }))
vi.mock('../../utils/api-helpers', () => ({ posApiGet: mocks.get }))
vi.mock('../useTerminalSettings', () => ({ default: () => ({ getSetting: (_category: string, key: string) => key === 'terminal_id' ? mocks.scope : key }) }))
const settle = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
beforeEach(() => {
  vi.useFakeTimers()
  mocks.scope = `main-${Math.random()}`
  mocks.get.mockResolvedValue({ success: true, data: payload() })
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers() })

const ID = '11111111-1111-4111-8111-111111111111'
const person = (state: WorkCardStaff['state'] = 'pending'): WorkCardStaff => ({
  staff_id: ID, state, punch: 'start', at: '2026-10-31T09:00:00Z', sent_at: null,
  protocol: null, action_required: null, at_risk: false,
})
const payload = (state: WorkCardStaff['state'] = 'pending') => ({ success: true, enabled: true, mode: 'dry_run', staff: [person(state)], attention_count: 2 })
const value = () => parseWorkCardStatus(payload())!

describe('work card display contract', () => {
  it('rejects errors and malformed answers; accepts disabled', () => {
    expect(parseWorkCardStatus({ enabled: false })).toEqual({ enabled: false })
    expect(parseWorkCardStatus({ success: false, code: 'MODULE_REQUIRED' })).toBeNull()
    expect(parseWorkCardStatus({ ...payload(), attention_count: -1 })).toBeNull()
    expect(parseWorkCardStatus({ ...payload(), staff: [{ ...person(), state: 'submitted' }] })).toBeNull()
  })
  it('bounds and deduplicates staff filters to 50 UUIDs per request', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`)
    expect(workCardStaffBatches([...ids, ids[0], 'local-only']).map(batch => batch.length)).toEqual([50, 1])
    expect(workCardStaffBatches([])).toEqual([[]])
  })
  it('expires staff values independently without renewing them on a banner read; isolates scope', () => {
    const cache = createWorkCardCache()
    cache.put('org/branch/main', value(), 100)
    cache.put('org/branch/main', { enabled: true, mode: 'dry_run', staff: [], attention_count: 3 }, 200)
    expect(cache.read('org/other/main', 200)).toBeNull()
    const current = cache.read('org/branch/main', WORK_CARD_MAX_AGE_MS + 100)
    expect(current?.enabled && current.staff).toEqual([])
    expect(cache.read('org/branch/main', WORK_CARD_MAX_AGE_MS + 200)).toBeNull()
    expect(cache.isEnabled('org/branch/main')).toBe(true)
    cache.put('org/branch/main', { enabled: false }, 1000)
    expect(cache.read('org/branch/main', 1000)).toEqual({ enabled: false })
  })
  it('uses the contract vocabulary, hides none/disabled and shows offline', () => {
    for (const state of ['sent', 'pending', 'dry_run', 'late', 'missing_exit', 'needs_action'] as const) {
      expect(workCardLineKey(parseWorkCardStatus(payload(state)), ID, false)).toBe(`workCard.${state}`)
    }
    expect(workCardLineKey(parseWorkCardStatus(payload('none')), ID, false)).toBeNull()
    expect(workCardLineKey({ enabled: false }, ID, true)).toBeNull()
    expect(workCardLineKey(value(), ID, true)).toBe('workCard.offline')
    expect(workCardLineKey(null, ID, true)).toBeNull()
    expect(workCardOpenShiftsHintKey(true, true)).toBe('workCard.zHint')
    expect(workCardOpenShiftsHintKey(false, true)).toBeNull()
    expect(workCardOpenShiftsHintKey(true, false)).toBeNull()
  })
})

describe('work card reader lifecycle', () => {
  it('keeps polling a previously enabled branch after stale display data expires', async () => {
    const hook = renderHook(() => useWorkCardStatus(true, [], true)); await settle()
    mocks.get.mockResolvedValue({ success: false, status: 503 })
    for (let minute = 0; minute < 5; minute++) {
      act(() => vi.advanceTimersByTime(60_000)); await settle()
    }
    expect(hook.result.current.data).toBeNull()
    mocks.get.mockResolvedValue({ success: true, data: payload() })
    act(() => vi.advanceTimersByTime(60_000)); await settle()
    expect(hook.result.current.data?.enabled).toBe(true)
    expect(mocks.get).toHaveBeenCalledTimes(7)
  })

  it('fetches on open, every 60 seconds while visible, and never closed or hidden', async () => {
    const hook = renderHook(({ active }) => useWorkCardStatus(active, [ID]), { initialProps: { active: true } })
    await settle()
    expect(hook.result.current.data?.enabled).toBe(true)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.get.mock.calls[0][0]).toContain(`staff_ids=${ID}`)
    act(() => vi.advanceTimersByTime(60_000)); await settle()
    expect(mocks.get).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    act(() => vi.advanceTimersByTime(60_000)); await settle()
    expect(mocks.get).toHaveBeenCalledTimes(2)
    hook.rerender({ active: false })
    act(() => vi.advanceTimersByTime(60_000)); await settle()
    expect(mocks.get).toHaveBeenCalledTimes(2)
  })
  it('keeps a good answer on failure for at most five minutes and shows offline', async () => {
    const hook = renderHook(() => useWorkCardStatus(true, [ID])); await settle()
    mocks.get.mockResolvedValue({ success: false, status: 503 })
    act(() => vi.advanceTimersByTime(60_000)); await settle()
    expect(hook.result.current.data?.enabled).toBe(true)
    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
      window.dispatchEvent(new Event('offline'))
    })
    expect(hook.result.current.offline).toBe(true)
    act(() => vi.advanceTimersByTime(WORK_CARD_MAX_AGE_MS - 60_000)); await settle()
    expect(hook.result.current.data).toBeNull()
  })
  it('drops a timed-out answer without changing a shift flow', async () => {
    let finish!: (response: unknown) => void
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const hook = renderHook(() => useWorkCardStatus(true, [ID]))
    act(() => vi.advanceTimersByTime(WORK_CARD_TIMEOUT_MS)); await settle()
    finish({ success: true, data: payload() }); await settle()
    expect(hook.result.current.data).toBeNull()
  })
  it('does not poll the Main banner when disabled', async () => {
    mocks.get.mockResolvedValue({ success: true, data: { enabled: false } })
    renderHook(() => useWorkCardStatus(true, [], true)); await settle()
    act(() => vi.advanceTimersByTime(180_000)); await settle()
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })
})
