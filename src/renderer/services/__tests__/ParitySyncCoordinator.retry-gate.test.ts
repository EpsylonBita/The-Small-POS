/**
 * Offline week Ω2 (22/10/2026): the renderer's 30 s parity retry runs only
 * when the till's own connectivity check (native `network:status`) says the
 * admin server is reachable. During an ISP outage `navigator.onLine` stays
 * true while the router is up, and every pass then loaded the database lock
 * with the whole due backlog for nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emitCompatEvent } from '../../../lib'
import {
  PARITY_SYNC_RETRY_INTERVAL_MS,
  shouldRunScheduledParityRetry,
  startScheduledParityRetry,
} from '../ParitySyncCoordinator'
import {
  getServerReachable,
  isServerConfirmedReachable,
  isTillKnownOffline,
  resetServerReachabilityForTests,
  subscribeConnectivityRestored,
} from '../server-reachability'

const PENDING = { pending: 12, failed: 0 }
const EMPTY = { pending: 0, failed: 0 }

describe('server reachability (passive native connectivity check)', () => {
  beforeEach(() => {
    resetServerReachabilityForTests()
  })
  afterEach(() => {
    resetServerReachabilityForTests()
    vi.restoreAllMocks()
  })

  it('is unknown until the native check reports, then follows it', () => {
    expect(getServerReachable()).toBeNull()
    expect(isTillKnownOffline()).toBe(false)
    expect(isServerConfirmedReachable()).toBe(false)

    emitCompatEvent('network:status', { isOnline: false })
    expect(getServerReachable()).toBe(false)
    expect(isTillKnownOffline()).toBe(true)

    emitCompatEvent('network:status', { isOnline: true })
    expect(getServerReachable()).toBe(true)
    expect(isServerConfirmedReachable()).toBe(true)

    // Malformed payloads change nothing.
    emitCompatEvent('network:status', { isOnline: 'yes' })
    emitCompatEvent('network:status', null)
    expect(getServerReachable()).toBe(true)
  })

  it('treats a browser without network as offline whatever the native check said', () => {
    emitCompatEvent('network:status', { isOnline: true })
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    expect(isTillKnownOffline()).toBe(true)
    expect(isServerConfirmedReachable()).toBe(false)
  })

  it('reports a restored connection on the browser online event and on the native unreachable-to-reachable turn only', () => {
    const restored = vi.fn()
    const unsubscribe = subscribeConnectivityRestored(restored)

    // The first report and repeated online reports (every sync cycle) are not a restore.
    emitCompatEvent('network:status', { isOnline: true })
    emitCompatEvent('network:status', { isOnline: true })
    expect(restored).not.toHaveBeenCalled()

    emitCompatEvent('network:status', { isOnline: false })
    emitCompatEvent('network:status', { isOnline: false })
    expect(restored).not.toHaveBeenCalled()
    emitCompatEvent('network:status', { isOnline: true })
    expect(restored).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('online'))
    expect(restored).toHaveBeenCalledTimes(2)

    unsubscribe()
    emitCompatEvent('network:status', { isOnline: false })
    emitCompatEvent('network:status', { isOnline: true })
    window.dispatchEvent(new Event('online'))
    expect(restored).toHaveBeenCalledTimes(2)
  })
})

describe('shouldRunScheduledParityRetry', () => {
  it('never runs while the till cannot reach the admin server, even with navigator.onLine true', () => {
    expect(shouldRunScheduledParityRetry({
      navigatorOnline: true,
      serverReachable: false,
      queueStatus: PENDING,
      lastSnapshot: { status: 'failed' },
    })).toBe(false)
  })

  it('waits for the first native report instead of trusting navigator.onLine', () => {
    expect(shouldRunScheduledParityRetry({
      navigatorOnline: true,
      serverReachable: null,
      queueStatus: PENDING,
      lastSnapshot: null,
    })).toBe(false)
  })

  it('keeps the existing work rule once the server is reachable', () => {
    const reachable = { navigatorOnline: true, serverReachable: true } as const
    expect(shouldRunScheduledParityRetry({ ...reachable, queueStatus: PENDING, lastSnapshot: null })).toBe(true)
    expect(shouldRunScheduledParityRetry({ ...reachable, queueStatus: { pending: 0, failed: 2 }, lastSnapshot: null })).toBe(true)
    expect(shouldRunScheduledParityRetry({ ...reachable, queueStatus: EMPTY, lastSnapshot: { status: 'failed' } })).toBe(true)
    expect(shouldRunScheduledParityRetry({ ...reachable, queueStatus: EMPTY, lastSnapshot: { status: 'skipped_missing_credentials' } })).toBe(true)
    expect(shouldRunScheduledParityRetry({ ...reachable, queueStatus: EMPTY, lastSnapshot: { status: 'completed' } })).toBe(false)
    expect(shouldRunScheduledParityRetry({ ...reachable, navigatorOnline: false, queueStatus: PENDING, lastSnapshot: null })).toBe(false)
  })
})

describe('startScheduledParityRetry (the App 30 s retry)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetServerReachabilityForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetServerReachabilityForTests()
  })

  it('offline status: no scheduled_retry pass; reachable again: the pass resumes', () => {
    const syncNow = vi.fn()
    const stop = startScheduledParityRetry({
      readQueueStatus: () => PENDING,
      readLastSnapshot: () => ({ status: 'failed' }),
      readServerReachable: getServerReachable,
      run: () => syncNow('scheduled_retry'),
    })

    // ISP outage: the router is up (navigator.onLine stays true), the till's
    // own check cannot reach the admin server.
    emitCompatEvent('network:status', { isOnline: false })
    vi.advanceTimersByTime(PARITY_SYNC_RETRY_INTERVAL_MS * 10)
    expect(syncNow).not.toHaveBeenCalled()

    emitCompatEvent('network:status', { isOnline: true })
    vi.advanceTimersByTime(PARITY_SYNC_RETRY_INTERVAL_MS)
    expect(syncNow).toHaveBeenCalledTimes(1)
    expect(syncNow).toHaveBeenCalledWith('scheduled_retry')

    stop()
    vi.advanceTimersByTime(PARITY_SYNC_RETRY_INTERVAL_MS * 3)
    expect(syncNow).toHaveBeenCalledTimes(1)
  })
})
