import type {
  RealtimeAuthHealth,
  RealtimeAuthService,
} from './RealtimeAuthService'

export interface DesktopRealtimeIdentity {
  terminalId: string
  organizationId: string
  branchId: string
}

export interface DesktopRealtimeRuntime {
  connect(): Promise<void>
  disconnect(): void
}

interface DesktopRealtimeAuthLifecycle {
  ensureAuthenticated(): Promise<void>
  getHealth(): RealtimeAuthHealth
  subscribe(listener: (health: RealtimeAuthHealth) => void): () => void
  stop(): void
}

export interface DesktopRealtimeLifecycleCoordinatorOptions {
  authService: RealtimeAuthService | DesktopRealtimeAuthLifecycle
  resolveIdentity(): Promise<DesktopRealtimeIdentity | null>
  createManager(identity: DesktopRealtimeIdentity): DesktopRealtimeRuntime
  subscribeAuthenticatedFeatures(
    identity: DesktopRealtimeIdentity,
  ): () => void
  onReadyChange?: (ready: boolean) => void
  onError?: (error: unknown) => void
}

type Activation = {
  manager: DesktopRealtimeRuntime
  generation: number
  promise: Promise<void>
}

function normalizeIdentity(
  identity: DesktopRealtimeIdentity | null,
): DesktopRealtimeIdentity | null {
  if (!identity) {
    return null
  }

  const normalized = {
    terminalId: identity.terminalId.trim(),
    organizationId: identity.organizationId.trim(),
    branchId: identity.branchId.trim(),
  }
  return normalized.terminalId &&
    normalized.organizationId &&
    normalized.branchId
    ? normalized
    : null
}

function identitiesEqual(
  left: DesktopRealtimeIdentity | null,
  right: DesktopRealtimeIdentity | null,
): boolean {
  return (
    left?.terminalId === right?.terminalId &&
    left?.organizationId === right?.organizationId &&
    left?.branchId === right?.branchId
  )
}

/**
 * Owns all desktop subscriptions that share the authenticated Supabase client.
 * Identity changes, auth loss, logout, and reset all flow through one teardown
 * path so no feature channel can outlive its terminal JWT.
 */
export class DesktopRealtimeLifecycleCoordinator {
  private readonly authService: DesktopRealtimeAuthLifecycle
  private readonly unsubscribeHealth: () => void

  private active = false
  private disposed = false
  private ready = false
  private identity: DesktopRealtimeIdentity | null = null
  private manager: DesktopRealtimeRuntime | null = null
  private unsubscribeFeatures: (() => void) | null = null
  private activation: Activation | null = null
  private lifecycleGeneration = 0
  private requestedIdentityVersion = 0
  private appliedIdentityVersion = 0
  private requestedCredentialVersion = 0
  private appliedCredentialVersion = 0
  private activeIdentityVersion = 0
  private refreshLoop: Promise<void> | null = null

  constructor(
    private readonly options: DesktopRealtimeLifecycleCoordinatorOptions,
  ) {
    this.authService = options.authService
    options.onReadyChange?.(false)
    this.unsubscribeHealth = this.authService.subscribe((health) => {
      this.handleAuthHealth(health)
    })
  }

  start(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }

    this.active = true
    return this.refreshIdentity()
  }

  credentialsChanged(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }

    this.active = true
    this.requestedCredentialVersion += 1
    this.activeIdentityVersion = 0
    this.deactivateRuntime(true)
    this.identity = null
    this.authService.stop()
    return this.requestIdentityRefresh()
  }

  refreshIdentity(): Promise<void> {
    if (!this.active || this.disposed) {
      return Promise.resolve()
    }

    return this.requestIdentityRefresh()
  }

  private requestIdentityRefresh(): Promise<void> {
    this.requestedIdentityVersion += 1
    if (!this.refreshLoop) {
      this.refreshLoop = this.drainIdentityRefreshes().finally(() => {
        this.refreshLoop = null
      })
    }
    return this.refreshLoop
  }

  stop(): void {
    if (this.disposed && !this.active) {
      return
    }

    this.active = false
    this.requestedIdentityVersion += 1
    this.appliedIdentityVersion = this.requestedIdentityVersion
    this.appliedCredentialVersion = this.requestedCredentialVersion
    this.activeIdentityVersion = 0
    this.deactivateRuntime(true)
    this.identity = null
    this.authService.stop()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.stop()
    this.disposed = true
    this.unsubscribeHealth()
  }

  private async drainIdentityRefreshes(): Promise<void> {
    while (
      this.active &&
      !this.disposed &&
      this.appliedIdentityVersion < this.requestedIdentityVersion
    ) {
      const version = this.requestedIdentityVersion
      let resolvedIdentity: DesktopRealtimeIdentity | null
      try {
        resolvedIdentity = await this.options.resolveIdentity()
      } catch (error) {
        this.appliedIdentityVersion = version
        this.options.onError?.(error)
        continue
      }

      if (!this.active || this.disposed) {
        return
      }

      if (version !== this.requestedIdentityVersion) {
        this.appliedIdentityVersion = version
        continue
      }

      const credentialVersion = this.requestedCredentialVersion
      const forceReauthenticate =
        credentialVersion > this.appliedCredentialVersion
      await this.reconcileIdentity(
        normalizeIdentity(resolvedIdentity),
        version,
        forceReauthenticate,
      )
      this.appliedIdentityVersion = version
      this.appliedCredentialVersion = credentialVersion
    }
  }

  private async reconcileIdentity(
    nextIdentity: DesktopRealtimeIdentity | null,
    version: number,
    forceReauthenticate: boolean,
  ): Promise<void> {
    if (!forceReauthenticate && identitiesEqual(this.identity, nextIdentity)) {
      this.activeIdentityVersion = version
      await this.activateRuntime()
      return
    }

    this.activeIdentityVersion = 0
    this.deactivateRuntime(true)
    this.identity = nextIdentity
    this.authService.stop()

    if (!nextIdentity || !this.active || this.disposed) {
      return
    }

    this.manager = this.options.createManager(nextIdentity)
    this.activeIdentityVersion = version
    await this.authService.ensureAuthenticated()

    if (
      !this.active ||
      this.disposed ||
      version !== this.requestedIdentityVersion
    ) {
      return
    }

    await this.activateRuntime()
  }

  private handleAuthHealth(health: RealtimeAuthHealth): void {
    if (!this.active || this.disposed) {
      return
    }

    if (health.status === 'authenticated') {
      void this.activateRuntime()
      return
    }

    if (health.status === 'disconnected') {
      this.deactivateRuntime(false)
    }
  }

  private async activateRuntime(): Promise<void> {
    const manager = this.manager
    const identity = this.identity
    if (
      !this.active ||
      this.disposed ||
      !manager ||
      !identity ||
      this.activeIdentityVersion !== this.requestedIdentityVersion ||
      this.authService.getHealth().status !== 'authenticated'
    ) {
      return
    }

    if (this.unsubscribeFeatures) {
      this.setReady(true)
      return
    }

    if (this.activation?.manager === manager) {
      return this.activation.promise
    }

    const generation = ++this.lifecycleGeneration
    const promise = (async () => {
      await manager.connect()

      if (!this.canActivate(manager, identity, generation)) {
        return
      }

      let unsubscribe: () => void
      try {
        unsubscribe = this.options.subscribeAuthenticatedFeatures(identity)
      } catch (error) {
        this.options.onError?.(error)
        manager.disconnect()
        return
      }

      if (!this.canActivate(manager, identity, generation)) {
        unsubscribe()
        return
      }

      this.unsubscribeFeatures = unsubscribe
      this.setReady(true)
    })()

    this.activation = { manager, generation, promise }
    try {
      await promise
    } finally {
      if (this.activation?.promise === promise) {
        this.activation = null
      }
    }
  }

  private canActivate(
    manager: DesktopRealtimeRuntime,
    identity: DesktopRealtimeIdentity,
    generation: number,
  ): boolean {
    return (
      this.active &&
      !this.disposed &&
      this.manager === manager &&
      this.identity === identity &&
      generation === this.lifecycleGeneration &&
      this.activeIdentityVersion === this.requestedIdentityVersion &&
      this.authService.getHealth().status === 'authenticated'
    )
  }

  private deactivateRuntime(dropManager: boolean): void {
    this.lifecycleGeneration += 1
    this.activation = null
    this.unsubscribeFeatures?.()
    this.unsubscribeFeatures = null
    this.manager?.disconnect()
    if (dropManager) {
      this.manager = null
    }
    this.setReady(false)
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) {
      return
    }
    this.ready = ready
    this.options.onReadyChange?.(ready)
  }
}
