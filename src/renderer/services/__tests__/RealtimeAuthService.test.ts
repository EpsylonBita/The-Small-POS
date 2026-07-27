import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  connectAfterRealtimeAuth,
  RealtimeAuthService,
} from '../RealtimeAuthService'

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

type PendingAuthMutation = {
  token: string | null
  completion: Deferred<void>
}

class StatefulDeferredAuthClient {
  appliedToken: string | null = null
  readonly pendingMutations: PendingAuthMutation[] = []

  readonly realtime = {
    setAuth: (token: string | null) => {
      const completion = deferred<void>()
      this.pendingMutations.push({ token, completion })
      return completion.promise.then(() => {
        this.appliedToken = token
      })
    },
  }

  pendingTokens(): Array<string | null> {
    return this.pendingMutations.map(({ token }) => token)
  }

  completeNext(expectedToken: string | null): void {
    const mutation = this.pendingMutations.shift()
    expect(mutation?.token).toBe(expectedToken)
    mutation?.completion.resolve()
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let count = 0; count < 12; count += 1) {
    await Promise.resolve()
  }
}

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

function transientResponse(status?: number) {
  return {
    success: false,
    status,
    error: status ? `HTTP ${status}` : 'Network error',
  }
}

describe('RealtimeAuthService', () => {
  const setAuth = vi.fn()
  const client = { realtime: { setAuth } }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T10:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches a terminal token and authenticates the supplied Realtime client', async () => {
    const requestToken = vi.fn().mockResolvedValue(tokenResponse('jwt-1'))
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()

    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(setAuth).toHaveBeenCalledWith('jwt-1')
    expect(service.getHealth()).toMatchObject({
      status: 'authenticated',
      reason: null,
      retryAttempt: 0,
    })
  })

  it('refreshes at 80 percent of the safe server TTL, before expiry', async () => {
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('jwt-1'))
      .mockResolvedValueOnce(tokenResponse('jwt-2'))
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()
    await vi.advanceTimersByTimeAsync(479_999)
    expect(requestToken).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)

    expect(requestToken).toHaveBeenCalledTimes(2)
    expect(setAuth).toHaveBeenLastCalledWith('jwt-2')
  })

  it('deduplicates concurrent initial authentication calls', async () => {
    const pending = deferred<ReturnType<typeof tokenResponse>>()
    const requestToken = vi.fn().mockReturnValue(pending.promise)
    const service = new RealtimeAuthService(client, { requestToken })

    const first = service.ensureAuthenticated()
    const second = service.ensureAuthenticated()

    expect(requestToken).toHaveBeenCalledTimes(1)
    pending.resolve(tokenResponse('jwt-shared'))
    await Promise.all([first, second])

    expect(setAuth).toHaveBeenCalledTimes(1)
    expect(setAuth).toHaveBeenCalledWith('jwt-shared')
  })

  it('deduplicates concurrent forced refreshes within one generation', async () => {
    const pendingRefresh = deferred<ReturnType<typeof tokenResponse>>()
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('jwt-1'))
      .mockReturnValueOnce(pendingRefresh.promise)
    const service = new RealtimeAuthService(client, { requestToken })
    await service.ensureAuthenticated()

    const first = service.refreshNow()
    const second = service.refreshNow()

    expect(requestToken).toHaveBeenCalledTimes(2)
    pendingRefresh.resolve(tokenResponse('jwt-2'))
    await Promise.all([first, second])
    expect(setAuth).toHaveBeenLastCalledWith('jwt-2')
  })

  it('uses bounded exponential retry and stops after five scheduled retries', async () => {
    const requestToken = vi.fn().mockResolvedValue(transientResponse())
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()
    expect(requestToken).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(requestToken).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(requestToken).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestToken).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(requestToken).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(requestToken).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requestToken).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(requestToken).toHaveBeenCalledTimes(6)
    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'transient-error',
      retryAttempt: 5,
    })
  })

  it('recovers after a transient network failure', async () => {
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce(transientResponse())
      .mockResolvedValueOnce(tokenResponse('jwt-recovered'))
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()
    expect(service.getHealth().status).toBe('disconnected')

    await vi.advanceTimersByTimeAsync(5_000)

    expect(setAuth).toHaveBeenLastCalledWith('jwt-recovered')
    expect(service.getHealth()).toMatchObject({
      status: 'authenticated',
      reason: null,
      retryAttempt: 0,
    })
  })

  it('does not hot-retry a 401 from an expired or revoked terminal', async () => {
    const requestToken = vi.fn().mockResolvedValue({
      success: false,
      status: 401,
      error: 'Terminal API key expired',
    })
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()
    await vi.advanceTimersByTimeAsync(180_000)

    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(setAuth).toHaveBeenLastCalledWith(null)
    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'permanent-denial',
      httpStatus: 401,
    })
  })

  it('does not hot-retry a 403 entitlement or branch denial', async () => {
    const requestToken = vi.fn().mockResolvedValue({
      success: false,
      status: 403,
      error: 'POS_REALTIME_BRANCH_REQUIRED',
    })
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()
    await vi.advanceTimersByTimeAsync(180_000)

    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(setAuth).toHaveBeenLastCalledWith(null)
    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'permanent-denial',
      httpStatus: 403,
    })
  })

  it('does not trust an HTTP denial marker when native status is absent', async () => {
    const requestToken = vi.fn().mockResolvedValue({
      success: false,
      error: 'Terminal branch identity is required (HTTP 403)',
    })
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()

    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'transient-error',
      retryAttempt: 1,
    })
    expect(service.getHealth().httpStatus).toBeUndefined()
  })

  it('retries a structured HTTP 500 even when server text contains denial markers', async () => {
    const requestToken = vi.fn().mockResolvedValue({
      success: false,
      status: 500,
      error:
        'Upstream says (HTTP 403) (HTTP 401): {"details":"not authoritative"}',
    })
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()
    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'transient-error',
      retryAttempt: 1,
      httpStatus: 500,
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(requestToken).toHaveBeenCalledTimes(2)
  })

  it('does not infer an HTTP denial from unrelated network error text', async () => {
    const requestToken = vi.fn().mockResolvedValue({
      success: false,
      error: 'Network request 403 timed out',
    })
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()

    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'transient-error',
      retryAttempt: 1,
    })
    expect(service.getHealth().httpStatus).toBeUndefined()
  })

  it('is recoverable after a permanent denial once terminal configuration restarts it', async () => {
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        status: 401,
        error: 'Terminal revoked',
      })
      .mockResolvedValueOnce(tokenResponse('jwt-reenrolled'))
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()
    service.stop()
    await service.ensureAuthenticated()

    expect(requestToken).toHaveBeenCalledTimes(2)
    expect(setAuth).toHaveBeenLastCalledWith('jwt-reenrolled')
    expect(service.getHealth().status).toBe('authenticated')
  })

  it('cancels refresh timers on stop and clears auth idempotently', async () => {
    const requestToken = vi.fn().mockResolvedValue(tokenResponse('jwt-1'))
    const service = new RealtimeAuthService(client, { requestToken })
    await service.ensureAuthenticated()

    service.stop()
    service.stop()
    await vi.advanceTimersByTimeAsync(600_000)

    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(setAuth).toHaveBeenLastCalledWith(null)
    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'stopped',
    })
  })

  it('ignores a token response that arrives after stop', async () => {
    const pending = deferred<ReturnType<typeof tokenResponse>>()
    const requestToken = vi.fn().mockReturnValue(pending.promise)
    const service = new RealtimeAuthService(client, { requestToken })

    const authentication = service.ensureAuthenticated()
    service.stop()
    pending.resolve(tokenResponse('jwt-late'))
    await authentication

    expect(setAuth.mock.calls.map(([token]) => token)).not.toContain('jwt-late')
    expect(setAuth).toHaveBeenLastCalledWith(null)
  })

  it('prevents an old terminal token from winning after re-enrollment', async () => {
    const oldRequest = deferred<ReturnType<typeof tokenResponse>>()
    const newRequest = deferred<ReturnType<typeof tokenResponse>>()
    const requestToken = vi
      .fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise)
    const service = new RealtimeAuthService(client, { requestToken })

    const oldAuthentication = service.ensureAuthenticated()
    service.stop()
    const newAuthentication = service.ensureAuthenticated()
    newRequest.resolve(tokenResponse('jwt-new-terminal'))
    await newAuthentication
    oldRequest.resolve(tokenResponse('jwt-old-terminal'))
    await oldAuthentication

    expect(setAuth).toHaveBeenCalledWith(null)
    expect(setAuth).toHaveBeenLastCalledWith('jwt-new-terminal')
    expect(setAuth.mock.calls.map(([token]) => token)).not.toContain('jwt-old-terminal')
  })

  it('applies a queued auth clear before the next terminal token', async () => {
    const authClient = new StatefulDeferredAuthClient()
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('jwt-old-terminal'))
      .mockResolvedValueOnce(tokenResponse('jwt-new-terminal'))
    const service = new RealtimeAuthService(authClient, { requestToken })

    const oldAuthentication = service.ensureAuthenticated()
    await flushMicrotasks()
    expect(authClient.pendingTokens()).toEqual(['jwt-old-terminal'])
    authClient.completeNext('jwt-old-terminal')
    await oldAuthentication

    service.stop()
    const newAuthentication = service.ensureAuthenticated()
    await flushMicrotasks()

    expect(authClient.pendingTokens()).toEqual([null])
    authClient.completeNext(null)
    await flushMicrotasks()
    expect(authClient.pendingTokens()).toEqual(['jwt-new-terminal'])
    authClient.completeNext('jwt-new-terminal')
    await newAuthentication

    expect(authClient.appliedToken).toBe('jwt-new-terminal')
    expect(service.getHealth().status).toBe('authenticated')
  })

  it('serializes stop and re-enrollment behind an in-flight auth mutation', async () => {
    const authClient = new StatefulDeferredAuthClient()
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('jwt-old-terminal'))
      .mockResolvedValueOnce(tokenResponse('jwt-new-terminal'))
    const service = new RealtimeAuthService(authClient, { requestToken })

    const oldAuthentication = service.ensureAuthenticated()
    await flushMicrotasks()
    expect(authClient.pendingTokens()).toEqual(['jwt-old-terminal'])

    service.stop()
    const newAuthentication = service.ensureAuthenticated()
    await flushMicrotasks()
    expect(authClient.pendingTokens()).toEqual(['jwt-old-terminal'])

    authClient.completeNext('jwt-old-terminal')
    await flushMicrotasks()
    expect(authClient.pendingTokens()).toEqual([null])
    authClient.completeNext(null)
    await flushMicrotasks()
    expect(authClient.pendingTokens()).toEqual(['jwt-new-terminal'])
    authClient.completeNext('jwt-new-terminal')
    await Promise.all([oldAuthentication, newAuthentication])

    expect(authClient.appliedToken).toBe('jwt-new-terminal')
    expect(service.getHealth().status).toBe('authenticated')
  })

  it('rejects malformed and already-expired token responses', async () => {
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        status: 200,
        data: {
          success: true,
          token: '',
          expiresAt: Date.now() + 600_000,
          expiresInSeconds: 600,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        status: 200,
        data: {
          success: true,
          token: 'jwt-expired',
          expiresAt: Date.now() - 1,
          expiresInSeconds: 600,
        },
      })
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()
    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'malformed-response',
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(setAuth.mock.calls.map(([token]) => token)).not.toContain('jwt-expired')
    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'malformed-response',
    })
  })

  it('authenticates the shared client before allowing a manager to connect', async () => {
    const order: string[] = []
    const orderedClient = {
      realtime: {
        setAuth: vi.fn((token: string | null) => {
          order.push(`auth:${token}`)
        }),
      },
    }
    const requestToken = vi.fn().mockResolvedValue(tokenResponse('jwt-before-connect'))
    const service = new RealtimeAuthService(orderedClient, { requestToken })

    const connected = await connectAfterRealtimeAuth(service, async () => {
      order.push('connect')
    })

    expect(connected).toBe(true)
    expect(order).toEqual(['auth:jwt-before-connect', 'connect'])
  })

  it('waits for the Realtime client to finish applying auth before connecting channels', async () => {
    const authApplied = deferred<void>()
    const order: string[] = []
    const asyncClient = {
      realtime: {
        setAuth: vi.fn((token: string | null) => {
          if (token === null) {
            return Promise.resolve()
          }
          return authApplied.promise.then(() => {
            order.push(`auth:${token}`)
          })
        }),
      },
    }
    const requestToken = vi.fn().mockResolvedValue(tokenResponse('jwt-async-auth'))
    const service = new RealtimeAuthService(asyncClient, { requestToken })
    const connect = vi.fn(async () => {
      order.push('connect')
    })
    const connection = connectAfterRealtimeAuth(service, connect)

    for (let microtask = 0; microtask < 10; microtask += 1) {
      await Promise.resolve()
    }
    expect(asyncClient.realtime.setAuth).toHaveBeenCalledWith('jwt-async-auth')
    expect(connect).not.toHaveBeenCalled()
    expect(order).toEqual([])

    authApplied.resolve()
    await connection
    expect(order).toEqual(['auth:jwt-async-auth', 'connect'])
  })

  it('treats an asynchronous setAuth rejection as recoverable disconnection', async () => {
    const asyncSetAuth = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket auth failed'))
      .mockResolvedValue(undefined)
    const asyncClient = { realtime: { setAuth: asyncSetAuth } }
    const requestToken = vi.fn().mockResolvedValue(tokenResponse('jwt-retry-auth'))
    const service = new RealtimeAuthService(asyncClient, { requestToken })

    await service.ensureAuthenticated()

    expect(service.getHealth()).toMatchObject({
      status: 'disconnected',
      reason: 'transient-error',
      retryAttempt: 1,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(service.getHealth().status).toBe('authenticated')
  })

  it('isolates and removes a health listener that throws during subscription', () => {
    const requestToken = vi.fn().mockResolvedValue(tokenResponse('jwt-1'))
    const service = new RealtimeAuthService(client, { requestToken })
    const listener = vi.fn(() => {
      throw new Error('feature listener failed')
    })

    const unsubscribe = service.subscribe(listener)
    service.stop()
    unsubscribe()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not connect feature channels while authentication is disconnected', async () => {
    const requestToken = vi.fn().mockResolvedValue({
      success: false,
      status: 403,
      error: 'MODULE_REQUIRED',
    })
    const service = new RealtimeAuthService(client, { requestToken })
    const connect = vi.fn()

    const connected = await connectAfterRealtimeAuth(service, connect)

    expect(connected).toBe(false)
    expect(connect).not.toHaveBeenCalled()
  })

  it('keeps JWTs in memory only without storage or logging side effects', async () => {
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')
    const logSpies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ]
    const requestToken = vi.fn().mockResolvedValue(tokenResponse('jwt-memory-only'))
    const service = new RealtimeAuthService(client, { requestToken })

    await service.ensureAuthenticated()

    expect(storageWrite).not.toHaveBeenCalled()
    for (const logSpy of logSpies) {
      expect(logSpy).not.toHaveBeenCalled()
    }
  })
})
