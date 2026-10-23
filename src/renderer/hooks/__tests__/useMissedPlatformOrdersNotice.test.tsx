/**
 * Desktop parity with Android's MissedPlatformOrdersNotice (offline week Ω6,
 * 22/10/2026): after reconnecting, the till shows the platform orders the
 * server declined as `terminal_offline` while it was away, looking back to
 * its last online moment, capped at 8 days.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ posApiGet: vi.fn() }))
vi.mock('../../../lib', async (original) => ({
  ...(await original<typeof import('../../../lib')>()),
  isBrowser: () => false,
}))
vi.mock('../../utils/api-helpers', () => ({ posApiGet: mocks.posApiGet }))

import { emitCompatEvent } from '../../../lib'
import { resetServerReachabilityForTests } from '../../services/server-reachability'
import {
  MISSED_PLATFORM_ORDERS_CHECKED_AT_KEY,
  MISSED_PLATFORM_ORDERS_DEFAULT_LOOKBACK_MS,
  MISSED_PLATFORM_ORDERS_ENDPOINT,
  MISSED_PLATFORM_ORDERS_MAX_LOOKBACK_MS,
  checkMissedPlatformOrders,
  defaultMissedPlatformOrdersDeps,
  missedPlatformOrdersSince,
  useMissedPlatformOrdersNotice,
  type MissedPlatformOrdersDeps,
} from '../useMissedPlatformOrdersNotice'

const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const DAY_MS = 86_400_000

function declined(id: string, total: number) {
  return { id, order_number: `EF-${id}`, platform: 'efood', total_amount: total }
}

function fakeDeps(overrides: Partial<MissedPlatformOrdersDeps> & { stored?: string | null } = {}) {
  const state = { stored: overrides.stored ?? null, clock: NOW }
  const deps: MissedPlatformOrdersDeps = {
    now: () => state.clock,
    readCheckedAt: () => state.stored,
    writeCheckedAt: (iso) => {
      state.stored = iso
    },
    fetchDeclined: overrides.fetchDeclined ?? vi.fn(async () => ({ success: true, orders: [] })),
  }
  return { deps, state }
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let count = 0; count < 10; count += 1) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  resetServerReachabilityForTests()
  mocks.posApiGet.mockReset()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  resetServerReachabilityForTests()
  vi.restoreAllMocks()
})

describe('missedPlatformOrdersSince', () => {
  it('looks back to the stored watermark, capped at 8 days', () => {
    const threeDaysAgo = new Date(NOW - 3 * DAY_MS).toISOString()
    expect(missedPlatformOrdersSince(threeDaysAgo, NOW)).toBe(threeDaysAgo)

    const floor = new Date(NOW - MISSED_PLATFORM_ORDERS_MAX_LOOKBACK_MS).toISOString()
    expect(MISSED_PLATFORM_ORDERS_MAX_LOOKBACK_MS).toBe(8 * DAY_MS)
    expect(missedPlatformOrdersSince(new Date(NOW - 20 * DAY_MS).toISOString(), NOW)).toBe(floor)
    // Android used to stop at 12 h: day 1-6 declines were never announced.
    expect(missedPlatformOrdersSince(new Date(NOW - 7 * DAY_MS).toISOString(), NOW)).toBe(
      new Date(NOW - 7 * DAY_MS).toISOString(),
    )
  })

  it('looks back 12 h without a usable watermark, as Android does', () => {
    const firstCheck = new Date(NOW - MISSED_PLATFORM_ORDERS_DEFAULT_LOOKBACK_MS).toISOString()
    expect(MISSED_PLATFORM_ORDERS_DEFAULT_LOOKBACK_MS).toBe(12 * 60 * 60 * 1000)
    expect(missedPlatformOrdersSince(null, NOW)).toBe(firstCheck)
    expect(missedPlatformOrdersSince('not a date', NOW)).toBe(firstCheck)
    // A future watermark (the clock moved back) is not trusted.
    expect(missedPlatformOrdersSince(new Date(NOW + DAY_MS).toISOString(), NOW)).toBe(firstCheck)
  })
})

describe('checkMissedPlatformOrders', () => {
  it('counts and totals the declines, then moves the watermark to the check start', async () => {
    const stored = new Date(NOW - 2 * DAY_MS).toISOString()
    const fetchDeclined = vi.fn(async () => ({
      success: true,
      orders: [declined('1', 18.5), declined('2', '7.25'), { id: '' }, declined('3', 0)],
    }))
    const { deps, state } = fakeDeps({ stored, fetchDeclined })

    const result = await checkMissedPlatformOrders(deps)

    expect(fetchDeclined).toHaveBeenCalledWith(stored)
    expect(result?.count).toBe(3)
    expect(result?.total).toBeCloseTo(25.75)
    expect(state.stored).toBe(new Date(NOW).toISOString())
  })

  it('advances the watermark when nothing was missed', async () => {
    const { deps, state } = fakeDeps()
    expect(await checkMissedPlatformOrders(deps)).toEqual({ orders: [], count: 0, total: 0 })
    expect(state.stored).toBe(new Date(NOW).toISOString())
  })

  it('a failed or malformed read is silent and keeps the watermark', async () => {
    const stored = new Date(NOW - DAY_MS).toISOString()
    for (const fetchDeclined of [
      vi.fn(async () => {
        throw new Error('offline')
      }),
      vi.fn(async () => ({ success: false, error: 'Supabase request failed' })),
      vi.fn(async () => ({ success: true })),
      vi.fn(async () => null),
    ]) {
      const { deps, state } = fakeDeps({ stored, fetchDeclined })
      expect(await checkMissedPlatformOrders(deps)).toBeNull()
      expect(state.stored).toBe(stored)
    }
  })

  it('asks the terminal-authenticated server route with only the look-back start', async () => {
    const watermark = new Date(Date.now() - 2 * DAY_MS).toISOString()
    mocks.posApiGet.mockResolvedValue({
      success: true,
      source: 'remote',
      stale: false,
      data: { success: true, orders: [declined('9', 12)] },
    })
    localStorage.setItem(MISSED_PLATFORM_ORDERS_CHECKED_AT_KEY, watermark)

    const result = await checkMissedPlatformOrders(defaultMissedPlatformOrdersDeps)

    expect(mocks.posApiGet).toHaveBeenCalledWith(
      `${MISSED_PLATFORM_ORDERS_ENDPOINT}?since=${encodeURIComponent(watermark)}`,
    )
    expect(result?.count).toBe(1)
    expect(Date.parse(localStorage.getItem(MISSED_PLATFORM_ORDERS_CHECKED_AT_KEY) ?? '')).toBeGreaterThan(
      Date.parse(watermark),
    )
  })

  it('a missing route, a refusal or a saved copy of an older answer never moves the watermark', async () => {
    const watermark = new Date(Date.now() - 2 * DAY_MS).toISOString()
    for (const answer of [
      { success: false, status: 404, error: 'Not found' },
      { success: false, error: 'Network error' },
      { success: true, source: 'cache', stale: true, data: { success: true, orders: [declined('1', 9)] } },
    ]) {
      mocks.posApiGet.mockResolvedValueOnce(answer)
      localStorage.setItem(MISSED_PLATFORM_ORDERS_CHECKED_AT_KEY, watermark)
      expect(await checkMissedPlatformOrders(defaultMissedPlatformOrdersDeps)).toBeNull()
      expect(localStorage.getItem(MISSED_PLATFORM_ORDERS_CHECKED_AT_KEY)).toBe(watermark)
    }
  })
})

describe('useMissedPlatformOrdersNotice', () => {
  it('checks at start and shows what was declined while the till was closed', async () => {
    const fetchDeclined = vi.fn(async () => ({ success: true, orders: [declined('1', 20), declined('2', 15)] }))
    const { deps } = fakeDeps({ fetchDeclined })
    const onMissed = vi.fn()

    renderHook(() => useMissedPlatformOrdersNotice(true, onMissed, deps))

    await waitFor(() => expect(onMissed).toHaveBeenCalledTimes(1))
    expect(onMissed.mock.calls[0][0]).toMatchObject({ count: 2, total: 35 })
    expect(fetchDeclined).toHaveBeenCalledWith(new Date(NOW - MISSED_PLATFORM_ORDERS_DEFAULT_LOOKBACK_MS).toISOString())
  })

  it('after an outage, announces the declines since the last online moment once the till reconnects', async () => {
    const lastOnline = new Date(NOW - 3 * DAY_MS).toISOString()
    let reachable = false
    const fetchDeclined = vi.fn(async () => {
      if (!reachable) throw new Error('Supabase request failed: offline')
      return { success: true, orders: [declined('1', 10), declined('2', 12), declined('3', 9)] }
    })
    const { deps, state } = fakeDeps({ stored: lastOnline, fetchDeclined })
    const onMissed = vi.fn()

    renderHook(() => useMissedPlatformOrdersNotice(true, onMissed, deps))
    await waitFor(() => expect(fetchDeclined).toHaveBeenCalledTimes(1))
    await settle()
    expect(onMissed).not.toHaveBeenCalled()
    expect(state.stored).toBe(lastOnline)

    // Three days later the ISP comes back.
    state.clock = NOW + 3 * DAY_MS
    act(() => {
      emitCompatEvent('network:status', { isOnline: false })
    })
    reachable = true
    act(() => {
      emitCompatEvent('network:status', { isOnline: true })
    })

    await waitFor(() => expect(onMissed).toHaveBeenCalledTimes(1))
    expect(fetchDeclined).toHaveBeenLastCalledWith(lastOnline)
    expect(onMissed.mock.calls[0][0]).toMatchObject({ count: 3, total: 31 })
    expect(state.stored).toBe(new Date(NOW + 3 * DAY_MS).toISOString())
  })

  it('does not ask while the till knows it is offline, and asks once it is reachable', async () => {
    const fetchDeclined = vi.fn(async () => ({ success: true, orders: [declined('1', 5)] }))
    const { deps, state } = fakeDeps({ fetchDeclined })
    const onMissed = vi.fn()

    renderHook(() => useMissedPlatformOrdersNotice(true, onMissed, deps))
    await waitFor(() => expect(fetchDeclined).toHaveBeenCalledTimes(1))
    await settle()

    state.clock = NOW + 10 * 60_000
    act(() => {
      emitCompatEvent('network:status', { isOnline: false })
    })
    // The browser's `online` fires while the server is still unreachable: skip.
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await settle()
    expect(fetchDeclined).toHaveBeenCalledTimes(1)

    act(() => {
      emitCompatEvent('network:status', { isOnline: true })
    })
    await waitFor(() => expect(fetchDeclined).toHaveBeenCalledTimes(2))
  })

  it('does not repeat a successful check within a minute', async () => {
    const fetchDeclined = vi.fn(async () => ({ success: true, orders: [] }))
    const { deps, state } = fakeDeps({ fetchDeclined })

    renderHook(() => useMissedPlatformOrdersNotice(true, vi.fn(), deps))
    await waitFor(() => expect(fetchDeclined).toHaveBeenCalledTimes(1))
    await settle()

    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await settle()
    expect(fetchDeclined).toHaveBeenCalledTimes(1)

    state.clock = NOW + 61_000
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => expect(fetchDeclined).toHaveBeenCalledTimes(2))
  })

  it('stays off while disabled', async () => {
    const fetchDeclined = vi.fn(async () => ({ success: true, orders: [declined('1', 5)] }))
    const { deps } = fakeDeps({ fetchDeclined })

    renderHook(() => useMissedPlatformOrdersNotice(false, vi.fn(), deps))
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await settle()
    expect(fetchDeclined).not.toHaveBeenCalled()
  })
})
