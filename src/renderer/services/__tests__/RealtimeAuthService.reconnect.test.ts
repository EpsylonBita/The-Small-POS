/**
 * Offline week Ω6 (22/10/2026): after its five scheduled retries the realtime
 * token service used to stay disconnected until a re-login or a restart, so
 * realtime stayed down long after an outage (audit #18). Connectivity coming
 * back (the browser `online` event, or the till's own check turning reachable)
 * now restarts it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emitCompatEvent } from '../../../lib'
import { RealtimeAuthService } from '../RealtimeAuthService'
import { resetServerReachabilityForTests } from '../server-reachability'

function tokenResponse(token: string, ttlSeconds = 600) {
  return {
    success: true,
    status: 200,
    data: {
      success: true,
      token,
      expiresAt: Date.now() + ttlSeconds * 1_000,
      expiresInSeconds: ttlSeconds,
    },
  }
}

function transientResponse() {
  return { success: false, error: 'Network error' }
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  for (let count = 0; count < 12; count += 1) {
    await Promise.resolve()
  }
}

async function exhaustScheduledRetries(): Promise<void> {
  // 5 s, 10 s, 20 s, 40 s, 60 s, then nothing more.
  await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 40_000 + 60_000)
  await vi.advanceTimersByTimeAsync(10 * 60_000)
}

describe('RealtimeAuthService after an outage', () => {
  const setAuth = vi.fn()
  const client = { realtime: { setAuth } }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T10:00:00.000Z'))
    resetServerReachabilityForTests()
    setAuth.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetServerReachabilityForTests()
  })

  it('restarts when the till’s own connectivity check comes back after the retries gave up', async () => {
    let online = false
    const requestToken = vi.fn(async () => (online ? tokenResponse('jwt-after-outage') : transientResponse()))
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()
    // The till's own check reports the outage.
    emitCompatEvent('network:status', { isOnline: false })
    await exhaustScheduledRetries()
    expect(requestToken).toHaveBeenCalledTimes(6)
    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'transient-error',
      retryAttempt: 5,
    })

    // The ISP comes back: the native probe turns reachable.
    online = true
    emitCompatEvent('network:status', { isOnline: true })
    await flush()

    expect(requestToken).toHaveBeenCalledTimes(7)
    expect(setAuth).toHaveBeenLastCalledWith('jwt-after-outage')
    expect(service.getHealth()).toMatchObject({ status: 'authenticated', retryAttempt: 0 })
    service.stop()
  })

  it('restarts on the browser online event with a fresh retry budget', async () => {
    const requestToken = vi.fn(async () => transientResponse())
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()
    await exhaustScheduledRetries()
    expect(requestToken).toHaveBeenCalledTimes(6)

    window.dispatchEvent(new Event('online'))
    await flush()
    expect(requestToken).toHaveBeenCalledTimes(7)
    // Still failing: it schedules its retries again instead of giving up at once.
    expect(service.getHealth()).toMatchObject({ status: 'disconnected', retryAttempt: 1 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(requestToken).toHaveBeenCalledTimes(8)
    service.stop()
  })

  it('leaves an authenticated service, a permanent denial and a stopped service alone', async () => {
    const authenticatedToken = vi.fn(async () => tokenResponse('jwt-1'))
    const authenticated = new RealtimeAuthService(client, { requestToken: authenticatedToken })
    await authenticated.ensureAuthenticated()
    window.dispatchEvent(new Event('online'))
    await flush()
    expect(authenticatedToken).toHaveBeenCalledTimes(1)
    authenticated.stop()

    const deniedToken = vi.fn(async () => ({ success: false, status: 403, error: 'HTTP 403' }))
    const denied = new RealtimeAuthService(client, { requestToken: deniedToken })
    await denied.ensureAuthenticated()
    expect(denied.getHealth()).toMatchObject({ status: 'disconnected', reason: 'permanent-denial' })
    emitCompatEvent('network:status', { isOnline: false })
    emitCompatEvent('network:status', { isOnline: true })
    window.dispatchEvent(new Event('online'))
    await flush()
    expect(deniedToken).toHaveBeenCalledTimes(1)
    denied.stop()

    const stoppedToken = vi.fn(async () => transientResponse())
    const stopped = new RealtimeAuthService(client, { requestToken: stoppedToken })
    await stopped.ensureAuthenticated()
    stopped.stop()
    window.dispatchEvent(new Event('online'))
    await flush()
    expect(stoppedToken).toHaveBeenCalledTimes(1)
  })

  it('can be built without the connectivity subscription', async () => {
    const requestToken = vi.fn(async () => transientResponse())
    const service = new RealtimeAuthService(client, {
      requestToken,
      subscribeConnectivityRestored: null,
    })
    await service.ensureAuthenticated()
    await exhaustScheduledRetries()
    window.dispatchEvent(new Event('online'))
    await flush()
    expect(requestToken).toHaveBeenCalledTimes(6)
    service.stop()
  })
})
