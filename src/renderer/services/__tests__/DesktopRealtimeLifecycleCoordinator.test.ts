import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DesktopRealtimeLifecycleCoordinator,
  type DesktopRealtimeIdentity,
  type DesktopRealtimeRuntime,
} from '../DesktopRealtimeLifecycleCoordinator'
import { RealtimeAuthService } from '../RealtimeAuthService'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function tokenResponse(token: string) {
  return {
    success: true,
    status: 200,
    data: {
      success: true,
      token,
      expiresAt: Date.now() + 600_000,
      expiresInSeconds: 600,
    },
  }
}

function transientResponse() {
  return {
    success: false,
    error: 'Network unavailable',
  }
}

function identity(
  terminalId = 'terminal-1',
  organizationId = 'org-1',
  branchId = 'branch-1',
): DesktopRealtimeIdentity {
  return { terminalId, organizationId, branchId }
}

class RecordingRuntime implements DesktopRealtimeRuntime {
  readonly connect = vi.fn(async () => {})
  readonly disconnect = vi.fn()
}

async function flushMicrotasks(): Promise<void> {
  for (let count = 0; count < 12; count += 1) {
    await Promise.resolve()
  }
}

describe('DesktopRealtimeLifecycleCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T10:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not resolve identity or subscribe before the authenticated app lifecycle starts', () => {
    const requestToken = vi.fn().mockResolvedValue(tokenResponse('jwt-1'))
    const auth = new RealtimeAuthService(
      { realtime: { setAuth: vi.fn() } },
      { requestToken },
    )
    const resolveIdentity = vi.fn().mockResolvedValue(identity())
    const createManager = vi.fn(() => new RecordingRuntime())
    const subscribeAuthenticatedFeatures = vi.fn(() => vi.fn())

    new DesktopRealtimeLifecycleCoordinator({
      authService: auth,
      resolveIdentity,
      createManager,
      subscribeAuthenticatedFeatures,
    })

    expect(resolveIdentity).not.toHaveBeenCalled()
    expect(requestToken).not.toHaveBeenCalled()
    expect(createManager).not.toHaveBeenCalled()
    expect(subscribeAuthenticatedFeatures).not.toHaveBeenCalled()
  })

  it('applies auth before manager and feature subscriptions become ready', async () => {
    const pendingToken = deferred<ReturnType<typeof tokenResponse>>()
    const order: string[] = []
    const auth = new RealtimeAuthService(
      {
        realtime: {
          setAuth: vi.fn((token: string | null) => {
            order.push(`auth:${token}`)
          }),
        },
      },
      { requestToken: vi.fn().mockReturnValue(pendingToken.promise) },
    )
    const manager = new RecordingRuntime()
    manager.connect.mockImplementation(async () => {
      order.push('manager:connect')
    })
    const coordinator = new DesktopRealtimeLifecycleCoordinator({
      authService: auth,
      resolveIdentity: vi.fn().mockResolvedValue(identity()),
      createManager: vi.fn(() => manager),
      subscribeAuthenticatedFeatures: vi.fn(() => {
        order.push('features:subscribe')
        return () => {
          order.push('features:unsubscribe')
        }
      }),
      onReadyChange: (ready) => {
        order.push(`ready:${ready}`)
      },
    })

    const startup = coordinator.start()
    await flushMicrotasks()
    expect(manager.connect).not.toHaveBeenCalled()
    expect(order).not.toContain('features:subscribe')

    pendingToken.resolve(tokenResponse('jwt-1'))
    await startup

    expect(order).toEqual([
      'ready:false',
      'auth:null',
      'auth:jwt-1',
      'manager:connect',
      'features:subscribe',
      'ready:true',
    ])
  })

  it('tears down every feature channel on refresh failure and recreates them after recovery', async () => {
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('jwt-1'))
      .mockResolvedValueOnce(transientResponse())
      .mockResolvedValueOnce(tokenResponse('jwt-2'))
    const auth = new RealtimeAuthService(
      { realtime: { setAuth: vi.fn() } },
      { requestToken },
    )
    const manager = new RecordingRuntime()
    const unsubscribeFeatures = vi.fn()
    const subscribeAuthenticatedFeatures = vi.fn(() => unsubscribeFeatures)
    const readyStates: boolean[] = []
    const coordinator = new DesktopRealtimeLifecycleCoordinator({
      authService: auth,
      resolveIdentity: vi.fn().mockResolvedValue(identity()),
      createManager: vi.fn(() => manager),
      subscribeAuthenticatedFeatures,
      onReadyChange: (ready) => readyStates.push(ready),
    })
    await coordinator.start()

    await auth.refreshNow()

    expect(unsubscribeFeatures).toHaveBeenCalledTimes(1)
    expect(manager.disconnect).toHaveBeenCalledTimes(1)
    expect(readyStates.at(-1)).toBe(false)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(manager.connect).toHaveBeenCalledTimes(2)
    expect(subscribeAuthenticatedFeatures).toHaveBeenCalledTimes(2)
    expect(readyStates.at(-1)).toBe(true)
  })

  it('tears down channels before clearing auth on logout or reset stop', async () => {
    const order: string[] = []
    const auth = new RealtimeAuthService(
      {
        realtime: {
          setAuth: vi.fn((token: string | null) => {
            order.push(`auth:${token}`)
          }),
        },
      },
      { requestToken: vi.fn().mockResolvedValue(tokenResponse('jwt-1')) },
    )
    const manager = new RecordingRuntime()
    manager.disconnect.mockImplementation(() => {
      order.push('manager:disconnect')
    })
    const coordinator = new DesktopRealtimeLifecycleCoordinator({
      authService: auth,
      resolveIdentity: vi.fn().mockResolvedValue(identity()),
      createManager: vi.fn(() => manager),
      subscribeAuthenticatedFeatures: vi.fn(() => () => {
        order.push('features:unsubscribe')
      }),
    })
    await coordinator.start()
    order.length = 0

    coordinator.stop()
    await flushMicrotasks()

    expect(order).toEqual([
      'features:unsubscribe',
      'manager:disconnect',
      'auth:null',
    ])
  })

  it('keeps the current runtime for identical identity and replaces it for re-enrollment', async () => {
    let currentIdentity = identity()
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('jwt-1'))
      .mockResolvedValueOnce(tokenResponse('jwt-2'))
    const auth = new RealtimeAuthService(
      { realtime: { setAuth: vi.fn() } },
      { requestToken },
    )
    const managers: RecordingRuntime[] = []
    const createManager = vi.fn(() => {
      const manager = new RecordingRuntime()
      managers.push(manager)
      return manager
    })
    const subscribeAuthenticatedFeatures = vi.fn(() => vi.fn())
    const coordinator = new DesktopRealtimeLifecycleCoordinator({
      authService: auth,
      resolveIdentity: vi.fn(async () => currentIdentity),
      createManager,
      subscribeAuthenticatedFeatures,
    })
    await coordinator.start()

    await coordinator.refreshIdentity()
    expect(createManager).toHaveBeenCalledTimes(1)
    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(managers[0]?.disconnect).not.toHaveBeenCalled()

    currentIdentity = identity('terminal-2', 'org-1', 'branch-2')
    await coordinator.refreshIdentity()

    expect(managers[0]?.disconnect).toHaveBeenCalledTimes(1)
    expect(createManager).toHaveBeenCalledTimes(2)
    expect(requestToken).toHaveBeenCalledTimes(2)
    expect(subscribeAuthenticatedFeatures).toHaveBeenLastCalledWith(
      identity('terminal-2', 'org-1', 'branch-2'),
    )
  })

  it('force-reauthenticates once after same-identity credential replacement storms', async () => {
    const replacementToken = deferred<ReturnType<typeof tokenResponse>>()
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        status: 403,
        error: 'Terminal credentials were rejected',
      })
      .mockReturnValueOnce(replacementToken.promise)
    const auth = new RealtimeAuthService(
      { realtime: { setAuth: vi.fn() } },
      { requestToken },
    )
    const managers: RecordingRuntime[] = []
    const createManager = vi.fn(() => {
      const manager = new RecordingRuntime()
      managers.push(manager)
      return manager
    })
    const subscribeAuthenticatedFeatures = vi.fn(() => vi.fn())
    const readyStates: boolean[] = []
    const coordinator = new DesktopRealtimeLifecycleCoordinator({
      authService: auth,
      resolveIdentity: vi.fn().mockResolvedValue(identity()),
      createManager,
      subscribeAuthenticatedFeatures,
      onReadyChange: (ready) => readyStates.push(ready),
    })

    await coordinator.start()
    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(subscribeAuthenticatedFeatures).not.toHaveBeenCalled()
    expect(readyStates.at(-1)).toBe(false)

    const firstReplacement = coordinator.credentialsChanged()
    const secondReplacement = coordinator.credentialsChanged()
    await flushMicrotasks()

    expect(requestToken).toHaveBeenCalledTimes(2)
    expect(createManager).toHaveBeenCalledTimes(2)
    expect(managers[1]?.connect).not.toHaveBeenCalled()
    expect(subscribeAuthenticatedFeatures).not.toHaveBeenCalled()
    expect(readyStates.at(-1)).toBe(false)

    replacementToken.resolve(tokenResponse('jwt-replacement'))
    await Promise.all([firstReplacement, secondReplacement])

    expect(requestToken).toHaveBeenCalledTimes(2)
    expect(managers[1]?.connect).toHaveBeenCalledTimes(1)
    expect(subscribeAuthenticatedFeatures).toHaveBeenCalledTimes(1)
    expect(readyStates.at(-1)).toBe(true)
  })

  it('fails closed before resolving replacement credentials and ignores an obsolete resolution', async () => {
    const obsoleteResolution = deferred<DesktopRealtimeIdentity>()
    const latestResolution = deferred<DesktopRealtimeIdentity>()
    const replacementToken = deferred<ReturnType<typeof tokenResponse>>()
    const resolveIdentity = vi
      .fn()
      .mockResolvedValueOnce(identity())
      .mockReturnValueOnce(obsoleteResolution.promise)
      .mockReturnValueOnce(latestResolution.promise)
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('jwt-initial'))
      .mockReturnValueOnce(replacementToken.promise)
    const auth = new RealtimeAuthService(
      { realtime: { setAuth: vi.fn() } },
      { requestToken },
    )
    const managers: RecordingRuntime[] = []
    const createManager = vi.fn(() => {
      const manager = new RecordingRuntime()
      managers.push(manager)
      return manager
    })
    const unsubscribeFeatures = vi.fn()
    const subscribeAuthenticatedFeatures = vi.fn(() => unsubscribeFeatures)
    const readyStates: boolean[] = []
    const coordinator = new DesktopRealtimeLifecycleCoordinator({
      authService: auth,
      resolveIdentity,
      createManager,
      subscribeAuthenticatedFeatures,
      onReadyChange: (ready) => readyStates.push(ready),
    })
    await coordinator.start()
    const stopAuth = vi.spyOn(auth, 'stop')

    const firstReplacement = coordinator.credentialsChanged()

    expect(readyStates.at(-1)).toBe(false)
    expect(unsubscribeFeatures).toHaveBeenCalledTimes(1)
    expect(managers[0]?.disconnect).toHaveBeenCalledTimes(1)
    expect(stopAuth).toHaveBeenCalledTimes(1)

    const secondReplacement = coordinator.credentialsChanged()
    obsoleteResolution.resolve(identity())
    await flushMicrotasks()

    expect(resolveIdentity).toHaveBeenCalledTimes(3)
    expect(createManager).toHaveBeenCalledTimes(1)
    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(managers[0]?.connect).toHaveBeenCalledTimes(1)
    expect(subscribeAuthenticatedFeatures).toHaveBeenCalledTimes(1)
    expect(readyStates.at(-1)).toBe(false)

    latestResolution.resolve(identity())
    await flushMicrotasks()

    expect(createManager).toHaveBeenCalledTimes(2)
    expect(requestToken).toHaveBeenCalledTimes(2)
    expect(managers[0]?.connect).toHaveBeenCalledTimes(1)
    expect(managers[1]?.connect).not.toHaveBeenCalled()
    expect(subscribeAuthenticatedFeatures).toHaveBeenCalledTimes(1)
    expect(readyStates.at(-1)).toBe(false)

    replacementToken.resolve(tokenResponse('jwt-replacement'))
    await Promise.all([firstReplacement, secondReplacement])

    expect(managers[1]?.connect).toHaveBeenCalledTimes(1)
    expect(subscribeAuthenticatedFeatures).toHaveBeenCalledTimes(2)
    expect(readyStates.at(-1)).toBe(true)
  })

  it('stays closed after replacement identity lookup fails and recovers on a later config event', async () => {
    const failedResolution = deferred<DesktopRealtimeIdentity>()
    const lookupError = new Error('secure credential lookup failed')
    const resolveIdentity = vi
      .fn()
      .mockResolvedValueOnce(identity())
      .mockReturnValueOnce(failedResolution.promise)
      .mockResolvedValueOnce(identity())
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('jwt-initial'))
      .mockResolvedValueOnce(tokenResponse('jwt-recovered'))
    const auth = new RealtimeAuthService(
      { realtime: { setAuth: vi.fn() } },
      { requestToken },
    )
    const managers: RecordingRuntime[] = []
    const createManager = vi.fn(() => {
      const manager = new RecordingRuntime()
      managers.push(manager)
      return manager
    })
    const unsubscribeFeatures = vi.fn()
    const readyStates: boolean[] = []
    const onError = vi.fn()
    const coordinator = new DesktopRealtimeLifecycleCoordinator({
      authService: auth,
      resolveIdentity,
      createManager,
      subscribeAuthenticatedFeatures: vi.fn(() => unsubscribeFeatures),
      onReadyChange: (ready) => readyStates.push(ready),
      onError,
    })
    await coordinator.start()

    const replacement = coordinator.credentialsChanged()
    expect(readyStates.at(-1)).toBe(false)
    expect(unsubscribeFeatures).toHaveBeenCalledTimes(1)
    expect(managers[0]?.disconnect).toHaveBeenCalledTimes(1)

    failedResolution.reject(lookupError)
    await replacement
    await vi.advanceTimersByTimeAsync(180_000)

    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(lookupError)
    expect(createManager).toHaveBeenCalledTimes(1)
    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(readyStates.at(-1)).toBe(false)

    await coordinator.refreshIdentity()

    expect(createManager).toHaveBeenCalledTimes(2)
    expect(requestToken).toHaveBeenCalledTimes(2)
    expect(managers[1]?.connect).toHaveBeenCalledTimes(1)
    expect(readyStates.at(-1)).toBe(true)
  })

  it('coalesces identity event storms and discards an obsolete resolution', async () => {
    const obsoleteResolution = deferred<DesktopRealtimeIdentity>()
    const latestResolution = deferred<DesktopRealtimeIdentity>()
    const resolveIdentity = vi
      .fn()
      .mockReturnValueOnce(obsoleteResolution.promise)
      .mockReturnValueOnce(latestResolution.promise)
    const auth = new RealtimeAuthService(
      { realtime: { setAuth: vi.fn() } },
      { requestToken: vi.fn().mockResolvedValue(tokenResponse('jwt-latest')) },
    )
    const createManager = vi.fn(() => new RecordingRuntime())
    const coordinator = new DesktopRealtimeLifecycleCoordinator({
      authService: auth,
      resolveIdentity,
      createManager,
      subscribeAuthenticatedFeatures: vi.fn(() => vi.fn()),
    })

    const startup = coordinator.start()
    const refreshOne = coordinator.refreshIdentity()
    const refreshTwo = coordinator.refreshIdentity()
    obsoleteResolution.resolve(identity('terminal-old', 'org-old', 'branch-old'))
    await flushMicrotasks()
    latestResolution.resolve(identity('terminal-new', 'org-new', 'branch-new'))
    await Promise.all([startup, refreshOne, refreshTwo])

    expect(resolveIdentity).toHaveBeenCalledTimes(2)
    expect(createManager).toHaveBeenCalledTimes(1)
    expect(createManager).toHaveBeenCalledWith(
      identity('terminal-new', 'org-new', 'branch-new'),
    )
  })
})
