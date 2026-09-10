import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Store, RefreshCw, Loader2, AlertTriangle, WifiOff } from 'lucide-react'
import { posApiGet, posApiPost } from '../../utils/api-helpers'
import { POSGlassSwitch } from '../ui/pos-glass-components'
import { liquidGlassModalButton } from '../../styles/designSystem'

export interface Platform {
  plugin_id: string
  name: string
  open: boolean | null
  controllable: boolean
  /** Wolt-only: true when the provider is online AND actually taking orders right now. */
  accepting_orders?: boolean | null
  reason?: string | null
  checked_at?: string | null
}

// The API helper (posApiFetch) already unwraps the HTTP envelope into
// `response.data`, so the route's own JSON body — {success, platforms} /
// {success, platform} — is `response.data` directly, not `response.data.data`.
interface PlatformsListBody {
  success?: boolean
  platforms?: Platform[]
  error?: string
}

interface PlatformActionBody {
  success?: boolean
  platform?: Platform
  error?: string
}

type PendingAction = 'open' | 'close'

const REASON_DEFAULTS: Record<string, { key: string; defaultValue: string }> = {
  module_disabled: {
    key: 'settings.platforms.reason.moduleDisabled',
    defaultValue: 'A required module is not enabled on this register.',
  },
  unsupported: {
    key: 'settings.platforms.reason.unsupported',
    defaultValue: 'This platform cannot be opened or closed from here.',
  },
  wrong_terminal: {
    key: 'settings.platforms.reason.wrongTerminal',
    defaultValue: 'Manage this platform from its assigned register.',
  },
  production_not_connected: {
    key: 'settings.platforms.reason.productionNotConnected',
    defaultValue: 'This platform is not connected to a live store yet.',
  },
  provider_unavailable: {
    key: 'settings.platforms.reason.providerUnavailable',
    defaultValue: 'The platform is temporarily unavailable.',
  },
  busy: {
    key: 'settings.platforms.reason.busy',
    defaultValue: 'The platform is busy. Try again shortly.',
  },
  outcome_unknown: {
    key: 'settings.platforms.reason.outcomeUnknown',
    defaultValue: 'Status unknown. Refresh to check again.',
  },
  outside_hours: {
    key: 'settings.platforms.reason.outsideHours',
    defaultValue: 'Online, but outside the scheduled ordering hours — not receiving orders.',
  },
}

export const PlatformsSection: React.FC = () => {
  const { t } = useTranslation()
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [lastKnownOpen, setLastKnownOpen] = useState<Record<string, boolean>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pending, setPending] = useState<Record<string, PendingAction>>({})
  const [uncertain, setUncertain] = useState<Record<string, boolean>>({})
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator === 'undefined' || navigator.onLine !== false,
  )

  // Refs (not React state) so races are resolved deterministically and are not
  // sensitive to whether a re-render has happened yet:
  //  - listGenerationRef: every loadPlatforms() call claims the next number; a
  //    response is applied only if it is still the newest in flight, so an
  //    older/slower GET can never clobber a newer one.
  //  - mutationGenerationRef: bumped once when a toggle starts and once when it
  //    finishes. A refresh snapshots this map at request time; on response, any
  //    plugin whose counter is odd (mutation still in flight) or has moved since
  //    the snapshot (a mutation started and/or finished meanwhile) keeps its
  //    current in-memory value instead of being overwritten by the refresh.
  //  - inFlightRef: blocks a second toggle on the same plugin from starting
  //    before React has had a chance to re-render the disabled control.
  const listGenerationRef = useRef(0)
  const mutationGenerationRef = useRef<Record<string, number>>({})
  const inFlightRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadPlatforms = useCallback(async (options?: { refresh?: boolean }) => {
    const myGeneration = ++listGenerationRef.current
    const mutationSnapshot = { ...mutationGenerationRef.current }

    if (options?.refresh) {
      setIsRefreshing(true)
    } else {
      setIsLoading(true)
    }

    let response: Awaited<ReturnType<typeof posApiGet<PlatformsListBody>>> | null = null
    try {
      response = await posApiGet<PlatformsListBody>('/pos/platforms')
    } catch {
      response = { success: false }
    }

    if (!mountedRef.current || myGeneration !== listGenerationRef.current) return

    const body = response.data
    const list = body?.platforms
    if (!response.success || body?.success === false || !Array.isArray(list)) {
      // A failed read started before a toggle cannot invalidate the newer
      // confirmed write (or hide the operator's pending/unknown recovery UI).
      const supersededByMutation = Object.entries(mutationGenerationRef.current)
        .some(([pluginId, generation]) => generation % 2 === 1
          || generation !== (mutationSnapshot[pluginId] || 0))
      if (!supersededByMutation) {
        setLoadFailed(true)
      } else {
        setPlatforms(current => current.map(entry => {
          const generation = mutationGenerationRef.current[entry.plugin_id] || 0
          return generation % 2 === 1 || generation !== (mutationSnapshot[entry.plugin_id] || 0)
            ? entry
            : { ...entry, open: null, reason: 'provider_unavailable' }
        }))
      }
      setIsLoading(false)
      setIsRefreshing(false)
      return
    }

    setLoadFailed(false)
    setPlatforms((current) => {
      const stalePluginIds = new Set(
        Object.keys(mutationGenerationRef.current).filter((pluginId) => {
          const generation = mutationGenerationRef.current[pluginId] || 0
          const isMidMutation = generation % 2 === 1
          const movedSinceSnapshot = generation !== (mutationSnapshot[pluginId] || 0)
          return isMidMutation || movedSinceSnapshot
        }),
      )
      const incomingIds = new Set(list.map(entry => entry.plugin_id))
      const next = list.map((incoming) => {
        if (!stalePluginIds.has(incoming.plugin_id)) return incoming
        const existing = current.find((entry) => entry.plugin_id === incoming.plugin_id)
        return existing ?? incoming
      })
      // A newer server-confirmed mutation also supersedes an older list that
      // omitted its row. A fresh read with no intervening mutation can remove
      // revoked acquisitions normally.
      return next.concat(current.filter(entry => stalePluginIds.has(entry.plugin_id)
        && !incomingIds.has(entry.plugin_id)))
    })
    setUncertain((current) => {
      const next = { ...current }
      for (const incoming of list) {
        const generation = mutationGenerationRef.current[incoming.plugin_id] || 0
        const isMidMutation = generation % 2 === 1
        const movedSinceSnapshot = generation !== (mutationSnapshot[incoming.plugin_id] || 0)
        if (!isMidMutation && !movedSinceSnapshot) {
          delete next[incoming.plugin_id]
        }
      }
      return next
    })
    setIsLoading(false)
    setIsRefreshing(false)
  }, [])

  useEffect(() => {
    void loadPlatforms()
  }, [loadPlatforms])

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true)
      void loadPlatforms({ refresh: true })
    }
    const handleOffline = () => setIsOnline(false)
    const handleFocus = () => {
      if (navigator.onLine !== false) void loadPlatforms({ refresh: true })
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('focus', handleFocus)
    }
  }, [loadPlatforms])

  const setPlatform = (pluginId: string, next: Platform) => {
    setPlatforms((current) =>
      current.map((entry) => (entry.plugin_id === pluginId ? next : entry)),
    )
  }

  const handleToggle = async (platform: Platform, nextOpen: boolean) => {
    if (!isOnline) return
    if (inFlightRef.current.has(platform.plugin_id)) return
    inFlightRef.current.add(platform.plugin_id)
    mutationGenerationRef.current[platform.plugin_id] =
      (mutationGenerationRef.current[platform.plugin_id] || 0) + 1

    if (platform.open !== null) {
      setLastKnownOpen((current) => ({ ...current, [platform.plugin_id]: platform.open === true }))
    }
    setPending((current) => ({ ...current, [platform.plugin_id]: nextOpen ? 'open' : 'close' }))
    setUncertain((current) => ({ ...current, [platform.plugin_id]: false }))

    try {
      const response = await posApiPost<PlatformActionBody>('/pos/platforms', {
        plugin_id: platform.plugin_id,
        open: nextOpen,
      })
      if (!mountedRef.current) return
      const body = response.data

      if (response.success && body?.success !== false && body?.platform) {
        setPlatform(platform.plugin_id, body.platform)
        setUncertain((current) => ({ ...current, [platform.plugin_id]: false }))
        return
      }

      // The action's outcome could not be confirmed: show Unknown rather than
      // claiming the previous open/closed value is still accurate.
      setPlatform(platform.plugin_id, { ...platform, open: null, reason: 'outcome_unknown' })
      setUncertain((current) => ({ ...current, [platform.plugin_id]: true }))
    } catch {
      if (!mountedRef.current) return
      setPlatform(platform.plugin_id, { ...platform, open: null, reason: 'outcome_unknown' })
      setUncertain((current) => ({ ...current, [platform.plugin_id]: true }))
    } finally {
      mutationGenerationRef.current[platform.plugin_id] =
        (mutationGenerationRef.current[platform.plugin_id] || 0) + 1
      inFlightRef.current.delete(platform.plugin_id)
      if (mountedRef.current) {
        setPending((current) => {
          const next = { ...current }
          delete next[platform.plugin_id]
          return next
        })
      }
    }
  }

  const describeReason = (reason?: string | null): string | null => {
    if (!reason) return null
    const entry = REASON_DEFAULTS[reason]
    return entry
      ? t(entry.key, entry.defaultValue)
      : t('settings.platforms.reason.outcomeUnknown', 'Status unknown. Refresh to check again.')
  }

  const statusLabel = (open: boolean | null): string =>
    open === true
      ? t('settings.platforms.status.open', 'Open')
      : open === false
        ? t('settings.platforms.status.closed', 'Closed')
        : t('settings.platforms.status.unknown', 'Unknown')

  const statusToneClass = (open: boolean | null): string =>
    open === true
      ? 'text-green-700 dark:text-green-400'
      : open === false
        ? 'liquid-glass-modal-text-muted'
        : 'text-amber-700 dark:text-amber-300'

  return (
    <div
      id="settings-section-platforms"
      className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-black/10 px-4 py-4 space-y-4 transition-all"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-yellow-400 text-black ring-1 ring-yellow-500/55 shadow-[0_8px_20px_rgba(250,204,21,0.22)]">
            <Store className="h-5 w-5 text-black" />
          </span>
          <div className="min-w-0">
            <span className="block font-semibold liquid-glass-modal-text">
              {t('settings.platforms.title', 'Delivery Platforms')}
            </span>
            <span className="block text-xs liquid-glass-modal-text-muted">
              {t(
                'settings.platforms.helpText',
                'Open or close connected delivery platforms for this store',
              )}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadPlatforms({ refresh: true })}
          disabled={isLoading || isRefreshing}
          className={liquidGlassModalButton('secondary', 'md')}
        >
          <span className="inline-flex items-center gap-2">
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {t('settings.platforms.refresh', 'Refresh')}
          </span>
        </button>
      </div>

      <p className="text-xs liquid-glass-modal-text-muted">
        {t(
          'settings.platforms.manualClosureNote',
          'You can reopen a platform here at any time. If efood stays closed, it reopens at the first register opening after the next Z report.',
        )}
      </p>

      {!isOnline && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <WifiOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <span className="text-sm liquid-glass-modal-text">
            {t(
              'settings.platforms.offline',
              'This register is offline. Reconnect to open or close platforms.',
            )}
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm liquid-glass-modal-text-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t('settings.platforms.loading', 'Loading platforms...')}
        </div>
      ) : loadFailed ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          <span className="text-sm liquid-glass-modal-text">
            {t('settings.platforms.loadFailed', 'Could not load platforms')}
          </span>
        </div>
      ) : platforms.length === 0 ? (
        <div className="rounded-xl border liquid-glass-modal-border bg-white/5 px-4 py-8 text-center dark:bg-black/10">
          <Store className="mx-auto mb-2 h-8 w-8 opacity-40 liquid-glass-modal-text-muted" />
          <p className="text-sm font-medium liquid-glass-modal-text">
            {t('settings.platforms.empty', 'No delivery platforms connected')}
          </p>
          <p className="mt-1 text-xs liquid-glass-modal-text-muted">
            {t(
              'settings.platforms.emptyHelp',
              'Connect a delivery platform from the admin dashboard to manage it here.',
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {platforms.map((platform) => {
            const action = pending[platform.plugin_id]
            const isPending = Boolean(action)
            const isUncertain = Boolean(uncertain[platform.plugin_id])
            const reasonText = describeReason(platform.reason)
            const showExplicitActions = platform.controllable && platform.open === null
            const knownBefore = lastKnownOpen[platform.plugin_id]
            const showAcceptingOrders =
              platform.open === true && typeof platform.accepting_orders === 'boolean'

            return (
              <div
                key={platform.plugin_id}
                className="rounded-xl border liquid-glass-modal-border bg-white/5 px-4 py-3 space-y-2 dark:bg-gray-800/10"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span
                      id={`platform-${platform.plugin_id}-label`}
                      className="block truncate font-medium liquid-glass-modal-text"
                    >
                      {platform.name}
                    </span>
                    <span className={`block text-xs font-semibold ${statusToneClass(platform.open)}`}>
                      {statusLabel(platform.open)}
                    </span>
                    {showAcceptingOrders && (
                      <span className="block text-xs liquid-glass-modal-text-muted">
                        {platform.accepting_orders
                          ? t('settings.platforms.acceptingOrders', 'Receiving orders')
                          : t(
                              'settings.platforms.notAcceptingOrders',
                              'Not receiving orders right now',
                            )}
                      </span>
                    )}
                    {reasonText && (
                      <span className="block text-xs liquid-glass-modal-text-muted">
                        {reasonText}
                      </span>
                    )}
                    {isUncertain && (
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        {t(
                          'settings.platforms.uncertain',
                          'Could not confirm the result. Refresh to check the current status.',
                        )}
                      </span>
                    )}
                    {platform.open === null && typeof knownBefore === 'boolean' && (
                      <span className="block text-xs liquid-glass-modal-text-muted">
                        {t('settings.platforms.lastKnown', {
                          status: knownBefore
                            ? t('settings.platforms.status.open', 'Open')
                            : t('settings.platforms.status.closed', 'Closed'),
                          defaultValue: 'Last known: {{status}}',
                        })}
                      </span>
                    )}
                  </div>

                  {!platform.controllable ? (
                    <POSGlassSwitch
                      aria-labelledby={`platform-${platform.plugin_id}-label`}
                      checked={false}
                      disabled
                    />
                  ) : showExplicitActions ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleToggle(platform, true)}
                        disabled={!isOnline || isPending}
                        className={liquidGlassModalButton('secondary', 'md')}
                      >
                        <span className="inline-flex items-center gap-2">
                          {action === 'open' && <Loader2 className="h-4 w-4 animate-spin" />}
                          {t('settings.platforms.open', 'Open')}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleToggle(platform, false)}
                        disabled={!isOnline || isPending}
                        className={liquidGlassModalButton('secondary', 'md')}
                      >
                        <span className="inline-flex items-center gap-2">
                          {action === 'close' && <Loader2 className="h-4 w-4 animate-spin" />}
                          {t('settings.platforms.close', 'Close')}
                        </span>
                      </button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      {isPending && <Loader2 className="h-4 w-4 animate-spin liquid-glass-modal-text-muted" />}
                      <POSGlassSwitch
                        aria-labelledby={`platform-${platform.plugin_id}-label`}
                        checked={platform.open === true}
                        disabled={!isOnline || isPending}
                        onChange={(next) => void handleToggle(platform, next)}
                      />
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default PlatformsSection
