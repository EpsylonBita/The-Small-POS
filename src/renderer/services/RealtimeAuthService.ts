import { posApiFetch } from '../utils/api-helpers'

const REFRESH_FRACTION = 0.8
const REFRESH_SAFETY_MS = 30_000
const MIN_USABLE_TTL_MS = 1_000
const MIN_REFRESH_DELAY_MS = 250
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000
const MAX_SCHEDULED_RETRIES = 5

type MaybePromise<T> = T | Promise<T>

export interface RealtimeAuthClient {
  realtime: {
    setAuth(token: string | null): MaybePromise<unknown>
  }
}

export interface RealtimeTokenRequestResult {
  success: boolean
  data?: unknown
  error?: string
  status?: number
}

export type RealtimeAuthHealthStatus =
  | 'disconnected'
  | 'authenticating'
  | 'authenticated'

export type RealtimeAuthDisconnectReason =
  | 'stopped'
  | 'transient-error'
  | 'permanent-denial'
  | 'malformed-response'
  | null

export interface RealtimeAuthHealth {
  status: RealtimeAuthHealthStatus
  reason: RealtimeAuthDisconnectReason
  retryAttempt: number
  httpStatus?: number
  updatedAt: number
}

export interface RealtimeAuthServiceOptions {
  requestToken?: () => Promise<RealtimeTokenRequestResult>
  now?: () => number
}

type ValidToken = {
  token: string
  refreshDelayMs: number
}

type InFlightRequest = {
  generation: number
  promise: Promise<void>
}

async function requestRealtimeToken(): Promise<RealtimeTokenRequestResult> {
  return posApiFetch<unknown>('pos/realtime/token', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

function isPermanentDenial(status: number | undefined): boolean {
  return status === 401 || status === 403
}

function resolveHttpStatus(result: RealtimeTokenRequestResult): number | undefined {
  return typeof result.status === 'number' ? result.status : undefined
}

/**
 * Owns the short-lived JWT used by Supabase Realtime on desktop.
 *
 * Tokens are retained only inside the Supabase client. This service never
 * writes them to storage, settings, files, logs, or the native credential
 * bridge.
 */
export class RealtimeAuthService {
  private readonly requestToken: () => Promise<RealtimeTokenRequestResult>
  private readonly now: () => number
  private readonly listeners = new Set<(health: RealtimeAuthHealth) => void>()

  private generation = 0
  private active = false
  private retryAttempt = 0
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight: InFlightRequest | null = null
  private authMutationTail: Promise<void> = Promise.resolve()
  private stopClearQueued = false
  private health: RealtimeAuthHealth

  constructor(
    private readonly client: RealtimeAuthClient,
    options: RealtimeAuthServiceOptions = {},
  ) {
    this.requestToken = options.requestToken ?? requestRealtimeToken
    this.now = options.now ?? Date.now
    this.health = {
      status: 'disconnected',
      reason: 'stopped',
      retryAttempt: 0,
      updatedAt: this.now(),
    }
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.active) {
      this.beginGeneration()
    } else if (this.health.status === 'authenticated') {
      return
    } else if (this.health.reason === 'permanent-denial') {
      return
    }

    return this.fetchForGeneration(this.generation)
  }

  async refreshNow(): Promise<void> {
    if (!this.active) {
      this.beginGeneration()
    }

    this.clearRefreshTimer()
    this.setHealth({
      status: 'authenticating',
      reason: null,
      retryAttempt: this.retryAttempt,
    })
    return this.fetchForGeneration(this.generation)
  }

  stop(): void {
    const shouldQueueClear = !this.stopClearQueued
    this.active = false
    this.generation += 1
    this.retryAttempt = 0
    this.inFlight = null
    this.clearRefreshTimer()
    if (shouldQueueClear) {
      this.stopClearQueued = true
      this.queueClientAuthClear()
    }
    this.setHealth({
      status: 'disconnected',
      reason: 'stopped',
      retryAttempt: 0,
    })
  }

  getHealth(): RealtimeAuthHealth {
    return { ...this.health }
  }

  subscribe(listener: (health: RealtimeAuthHealth) => void): () => void {
    this.listeners.add(listener)
    try {
      listener(this.getHealth())
    } catch {
      this.listeners.delete(listener)
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  private beginGeneration(): void {
    this.active = true
    this.generation += 1
    this.retryAttempt = 0
    this.inFlight = null
    this.stopClearQueued = false
    this.clearRefreshTimer()
    this.setHealth({
      status: 'authenticating',
      reason: null,
      retryAttempt: 0,
    })
  }

  private fetchForGeneration(generation: number): Promise<void> {
    if (!this.active || generation !== this.generation) {
      return Promise.resolve()
    }

    if (this.inFlight?.generation === generation) {
      return this.inFlight.promise
    }

    const promise = this.fetchAndApply(generation).finally(() => {
      if (this.inFlight?.promise === promise) {
        this.inFlight = null
      }
    })
    this.inFlight = { generation, promise }
    return promise
  }

  private async fetchAndApply(generation: number): Promise<void> {
    let result: RealtimeTokenRequestResult
    try {
      result = await this.requestToken()
    } catch {
      if (this.isCurrent(generation)) {
        this.handleRetryableFailure(generation, 'transient-error')
      }
      return
    }

    if (!this.isCurrent(generation)) {
      return
    }

    if (!result.success) {
      const httpStatus = resolveHttpStatus(result)
      if (isPermanentDenial(httpStatus)) {
        this.queueClientAuthClear()
        this.clearRefreshTimer()
        this.setHealth({
          status: 'disconnected',
          reason: 'permanent-denial',
          retryAttempt: this.retryAttempt,
          httpStatus,
        })
        return
      }

      this.handleRetryableFailure(generation, 'transient-error', httpStatus)
      return
    }

    const validToken = this.parseToken(result.data)
    if (!validToken) {
      this.handleRetryableFailure(generation, 'malformed-response', result.status)
      return
    }

    let applied = false
    try {
      applied = await this.queueClientAuthToken(generation, validToken.token)
    } catch {
      this.handleRetryableFailure(generation, 'transient-error')
      return
    }

    if (!applied || !this.isCurrent(generation)) {
      return
    }

    this.retryAttempt = 0
    this.setHealth({
      status: 'authenticated',
      reason: null,
      retryAttempt: 0,
      httpStatus: result.status,
    })
    this.scheduleRefresh(generation, validToken.refreshDelayMs)
  }

  private parseToken(body: unknown): ValidToken | null {
    if (!body || typeof body !== 'object') {
      return null
    }

    const candidate = body as {
      success?: unknown
      token?: unknown
      expiresAt?: unknown
      expiresInSeconds?: unknown
    }
    const token = typeof candidate.token === 'string' ? candidate.token.trim() : ''
    const expiresAt =
      typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt)
        ? candidate.expiresAt
        : Number.NaN
    const expiresInSeconds =
      typeof candidate.expiresInSeconds === 'number' &&
      Number.isFinite(candidate.expiresInSeconds)
        ? candidate.expiresInSeconds
        : Number.NaN

    if (
      candidate.success !== true ||
      !token ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(expiresInSeconds) ||
      expiresInSeconds <= 0
    ) {
      return null
    }

    const remainingByExpiry = expiresAt - this.now()
    const remainingByTtl = expiresInSeconds * 1_000
    const usableTtlMs = Math.min(remainingByExpiry, remainingByTtl)
    if (!Number.isFinite(usableTtlMs) || usableTtlMs < MIN_USABLE_TTL_MS) {
      return null
    }

    const refreshDelayMs = Math.floor(
      Math.min(
        usableTtlMs * REFRESH_FRACTION,
        usableTtlMs - REFRESH_SAFETY_MS,
      ),
    )
    const safeRefreshDelayMs = Math.max(
      MIN_REFRESH_DELAY_MS,
      refreshDelayMs > 0 ? refreshDelayMs : usableTtlMs / 2,
    )

    if (safeRefreshDelayMs >= usableTtlMs) {
      return null
    }

    return {
      token,
      refreshDelayMs: safeRefreshDelayMs,
    }
  }

  private handleRetryableFailure(
    generation: number,
    reason: 'transient-error' | 'malformed-response',
    httpStatus?: number,
  ): void {
    if (!this.isCurrent(generation)) {
      return
    }

    this.queueClientAuthClear()
    this.clearRefreshTimer()

    if (this.retryAttempt >= MAX_SCHEDULED_RETRIES) {
      this.setHealth({
        status: 'disconnected',
        reason,
        retryAttempt: this.retryAttempt,
        httpStatus,
      })
      return
    }

    this.retryAttempt += 1
    this.setHealth({
      status: 'disconnected',
      reason,
      retryAttempt: this.retryAttempt,
      httpStatus,
    })

    const delay = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * 2 ** (this.retryAttempt - 1),
    )
    this.refreshTimer = setTimeout(() => {
      if (!this.isCurrent(generation)) {
        return
      }
      this.refreshTimer = null
      this.setHealth({
        status: 'authenticating',
        reason: null,
        retryAttempt: this.retryAttempt,
      })
      void this.fetchForGeneration(generation)
    }, delay)
  }

  private scheduleRefresh(generation: number, delayMs: number): void {
    this.clearRefreshTimer()
    this.refreshTimer = setTimeout(() => {
      if (!this.isCurrent(generation)) {
        return
      }
      this.refreshTimer = null
      void this.refreshNow()
    }, delayMs)
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  private queueAuthMutation<T>(mutation: () => MaybePromise<T>): Promise<T> {
    const queued = this.authMutationTail
      .catch(() => {})
      .then(mutation)
    this.authMutationTail = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  private queueClientAuthToken(
    generation: number,
    token: string,
  ): Promise<boolean> {
    return this.queueAuthMutation(async () => {
      if (!this.isCurrent(generation)) {
        return false
      }

      await this.client.realtime.setAuth(token)
      return this.isCurrent(generation)
    })
  }

  private queueClientAuthClear(): void {
    void this.queueAuthMutation(async () => {
      try {
        await this.client.realtime.setAuth(null)
      } catch {
        // Auth clearing is best-effort; the recovered tail still orders later tokens.
      }
    })
  }

  private setHealth(next: Omit<RealtimeAuthHealth, 'updatedAt'>): void {
    this.health = {
      ...next,
      updatedAt: this.now(),
    }
    const snapshot = this.getHealth()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // A feature health listener cannot break auth refresh.
      }
    }
  }
}

export async function connectAfterRealtimeAuth(
  authService: RealtimeAuthService,
  connect: () => MaybePromise<void>,
): Promise<boolean> {
  await authService.ensureAuthenticated()
  if (authService.getHealth().status !== 'authenticated') {
    return false
  }
  await connect()
  return true
}
