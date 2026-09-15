import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Store, RefreshCw, Loader2, AlertTriangle, WifiOff } from 'lucide-react'
import { posApiGet, posApiPost } from '../../utils/api-helpers'
import { POSGlassSwitch } from '../ui/pos-glass-components'
import { liquidGlassModalButton } from '../../styles/designSystem'
import { PlatformNotificationSoundSettings } from './PlatformNotificationSoundSettings'
import { EfoodWeeklyScheduleEditor } from './EfoodWeeklyScheduleEditor'
import type { EfoodDaySchedule } from '../../services/efoodWeeklySchedule'
import { useEfoodPartner } from '../../hooks/useEfoodPartner'

const EFOOD_PLUGIN_ID = 'efood'

// efood accepts an open/close write at once, but its own status read can lag
// for many minutes. While any platform waits for that confirmation the list is
// re-read on a fixed cadence measured from when the wait began: after 30 s,
// then every 60 s, for at most 15 minutes. Manual refresh stays available.
const CONFIRMATION_FIRST_REFRESH_MS = 30_000
const CONFIRMATION_REFRESH_INTERVAL_MS = 60_000
const CONFIRMATION_REFRESH_WINDOW_MS = 15 * 60_000

export interface Platform {
  plugin_id: string
  name: string
  open: boolean | null
  controllable: boolean
  /** Wolt-only: true when the provider is online AND actually taking orders right now. */
  accepting_orders?: boolean | null
  reason?: string | null
  checked_at?: string | null
  /**
   * efood: the provider accepted the change but its status has not caught up
   * yet. While true, `open` is the REQUESTED state, not a confirmed one.
   */
  pending?: boolean
  /**
   * efood: end of the current closure as Athens local wall time
   * 'YYYY-MM-DDTHH:mm:ss' (no offset), present while an efood closure interval
   * keeps the store closed.
   */
  closed_until?: string | null
  /**
   * efood: the status code of the closure in force as efood reports it, e.g.
   * 'close_indefinite' (a bounded machine code, or null when it is not one).
   */
  closure_status?: string | null
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

// The backend returns this exact marker only for a proved provider 403 on a
// platform write (HTTP 502 {success:false, error:'provider_forbidden'}); the
// Tauri IPC transport embeds it as "provider_forbidden (HTTP 502): ...", the
// same wrapping used for MODULE_REQUIRED. Never inferred from a bare 403.
function isProviderForbiddenError(error?: string | null): boolean {
  return typeof error === 'string' && /^provider_forbidden(?:$| \(HTTP 502\)(?::|$))/.test(error)
}

// efood refused the change itself (HTTP 502 {success:false,
// error:'provider_rejected'}), wrapped by the IPC transport the same way.
// Nothing changed at the provider, so the previous status is still accurate.
function isProviderRejectedError(error?: string | null): boolean {
  return typeof error === 'string' && /^provider_rejected(?:$| \(HTTP 502\)(?::|$))/.test(error)
}

// Accepted by the provider but not yet reflected in its status. Without a
// requested open/closed state there is nothing to wait for.
function isAwaitingProvider(platform: Platform): boolean {
  return platform.pending === true && typeof platform.open === 'boolean'
}

// efood closure reasons, sent with `open === false`. Each already says how the
// closure ends, so the status reads Closed with that explanation and never
// Opening…/Closing…, even while `pending` keeps the re-read loop running.
//  - closed_until_day_start: closed by the POS or the Z report until the first
//    cashier check-in; `closed_until` is only a distant safety bound, not shown.
//  - reopens_at_opening: ends when opening hours start, at `closed_until`.
const CLOSED_UNTIL_DAY_START_REASON = 'closed_until_day_start'
const REOPENS_AT_OPENING_REASON = 'reopens_at_opening'

function hasClosureReason(platform: Platform): boolean {
  return platform.open === false
    && (platform.reason === CLOSED_UNTIL_DAY_START_REASON || platform.reason === REOPENS_AT_OPENING_REASON)
}

const CLOSED_UNTIL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

const padTwo = (value: number): string => String(value).padStart(2, '0')

// `closed_until` is Athens wall time with no offset, so its components are read
// as written: `new Date(string)` would reinterpret them in this register's
// timezone. Ends today: "HH:mm"; any other day: short weekday + "HH:mm".
// A malformed value shows nothing rather than a wrong time.
function formatClosedUntil(value: string | null | undefined, language: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const match = CLOSED_UNTIL_PATTERN.exec(value)
  if (!match) return null
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText ?? '0') > 59) return null

  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const calendarDay = new Date(Date.UTC(year, month - 1, day))
  if (
    calendarDay.getUTCFullYear() !== year
    || calendarDay.getUTCMonth() !== month - 1
    || calendarDay.getUTCDate() !== day
  ) {
    return null
  }

  const time = `${hourText}:${minuteText}`
  const now = new Date()
  const today = `${now.getFullYear()}-${padTwo(now.getMonth() + 1)}-${padTwo(now.getDate())}`
  if (`${yearText}-${monthText}-${dayText}` === today) return time

  let weekday: string
  try {
    weekday = calendarDay.toLocaleDateString(language, { weekday: 'short', timeZone: 'UTC' })
  } catch {
    // An unusable language tag must not hide when the closure ends.
    weekday = calendarDay.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })
  }
  return `${weekday} ${time}`
}

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
  provider_forbidden: {
    key: 'settings.platforms.reason.providerForbidden',
    defaultValue:
      'The platform rejected this change (403). Use its app and ask its support to check API store-status permissions.',
  },
  outside_hours: {
    key: 'settings.platforms.reason.outsideHours',
    defaultValue: 'Online, but outside the scheduled ordering hours — not receiving orders.',
  },
  awaiting_provider_confirmation: {
    key: 'settings.platforms.reason.awaitingProviderConfirmation',
    defaultValue: 'The platform accepted the change. Its status can take a few minutes to update.',
  },
  provider_rejected: {
    key: 'settings.platforms.reason.providerRejected',
    defaultValue:
      "The platform refused this change. Outside opening hours, try again during them or use the platform's own app.",
  },
  provider_reports_closed: {
    key: 'settings.platforms.reason.providerReportsClosed',
    defaultValue: "The platform reports the store as closed. Check the platform's tablet or app.",
  },
  [CLOSED_UNTIL_DAY_START_REASON]: {
    key: 'settings.platforms.reason.closedUntilDayStart',
    defaultValue: 'Opens automatically when the first cashier checks in.',
  },
  // efood closed the store again after accepting an open: while its Partner
  // app is disconnected it keeps the store closed, whatever the API is told.
  closed_by_provider: {
    key: 'settings.platforms.reason.closedByProvider',
    defaultValue:
      'efood closed the store again after accepting the open. This usually means the efood Partner app is disconnected: open it, or ask efood to stop requiring a device.',
  },
  // reopens_at_opening is worded in describeReason: it needs the opening time.
}

export const PlatformsSection: React.FC = () => {
  const { t, i18n } = useTranslation()
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
  const [weeklyScheduleOpenFor, setWeeklyScheduleOpenFor] = useState<string | null>(null)
  // Lifted above the editor so an outstanding (unconfirmed) efood schedule
  // write survives closing and reopening the "Weekly hours" panel.
  const [efoodPendingSchedule, setEfoodPendingSchedule] = useState<EfoodDaySchedule[] | null>(null)
  // Bumped whenever a write comes back accepted-but-unconfirmed, so the
  // automatic re-read cadence restarts for that newest change.
  const [confirmationWaitRestarts, setConfirmationWaitRestarts] = useState(0)
  // efood Partner (Live Orders) hosted in the POS: its two local switches.
  const efoodPartner = useEfoodPartner()

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
  //  - confirmationWaitStartedAtRef: when the current wait for provider
  //    confirmation began (Date.now()), or null while nothing is waiting.
  const listGenerationRef = useRef(0)
  const mutationGenerationRef = useRef<Record<string, number>>({})
  const inFlightRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)
  const confirmationWaitStartedAtRef = useRef<number | null>(null)

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
            : { ...entry, open: null, pending: false, closed_until: null, reason: 'provider_unavailable' }
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

  const anyAwaitingProvider = platforms.some(isAwaitingProvider)

  useEffect(() => {
    if (!anyAwaitingProvider) {
      confirmationWaitStartedAtRef.current = null
      return undefined
    }
    if (confirmationWaitStartedAtRef.current === null) {
      confirmationWaitStartedAtRef.current = Date.now()
    }
    if (!isOnline) return undefined

    const startedAt = confirmationWaitStartedAtRef.current
    const elapsed = Date.now() - startedAt
    // Re-read n is due 30 s + n × 60 s after the wait began. Resuming (after
    // reconnecting, say) continues at the next slot still ahead, and nothing
    // is scheduled past the window.
    let slot = elapsed < CONFIRMATION_FIRST_REFRESH_MS
      ? 0
      : Math.floor((elapsed - CONFIRMATION_FIRST_REFRESH_MS) / CONFIRMATION_REFRESH_INTERVAL_MS) + 1
    let timer: ReturnType<typeof setTimeout> | undefined

    const scheduleNext = () => {
      const dueAfter = CONFIRMATION_FIRST_REFRESH_MS + slot * CONFIRMATION_REFRESH_INTERVAL_MS
      if (dueAfter > CONFIRMATION_REFRESH_WINDOW_MS) return
      const delay = Math.min(
        Math.max(dueAfter - (Date.now() - startedAt), 0),
        CONFIRMATION_REFRESH_INTERVAL_MS,
      )
      timer = setTimeout(() => {
        timer = undefined
        slot += 1
        if (navigator.onLine !== false) void loadPlatforms({ refresh: true })
        scheduleNext()
      }, delay)
    }

    scheduleNext()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [anyAwaitingProvider, isOnline, confirmationWaitRestarts, loadPlatforms])

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
        const next = body.platform
        setPlatform(platform.plugin_id, next)
        setUncertain((current) => ({ ...current, [platform.plugin_id]: false }))
        if (isAwaitingProvider(next)) {
          // Accepted, but not yet visible in the provider's status: restart the
          // automatic re-read cadence from this newest change.
          confirmationWaitStartedAtRef.current = Date.now()
          setConfirmationWaitRestarts((current) => current + 1)
        }
        return
      }

      if (isProviderForbiddenError(response.error) || isProviderForbiddenError(body?.error)) {
        // A proved provider refusal, not an unconfirmed request: status stays
        // Unknown (the write did not take effect) but this is not the generic
        // "could not confirm" uncertainty banner.
        setPlatform(platform.plugin_id, {
          ...platform,
          open: null,
          pending: false,
          closed_until: null,
          reason: 'provider_forbidden',
        })
        setUncertain((current) => ({ ...current, [platform.plugin_id]: false }))
        return
      }

      if (isProviderRejectedError(response.error) || isProviderRejectedError(body?.error)) {
        // efood refused the change outright, so nothing changed there: keep the
        // previous status (not Unknown) and say why, without the uncertainty banner.
        setPlatform(platform.plugin_id, { ...platform, reason: 'provider_rejected' })
        setUncertain((current) => ({ ...current, [platform.plugin_id]: false }))
        return
      }

      // The action's outcome could not be confirmed: show Unknown rather than
      // claiming the previous open/closed value is still accurate.
      setPlatform(platform.plugin_id, {
        ...platform,
        open: null,
        pending: false,
        closed_until: null,
        reason: 'outcome_unknown',
      })
      setUncertain((current) => ({ ...current, [platform.plugin_id]: true }))
    } catch {
      if (!mountedRef.current) return
      setPlatform(platform.plugin_id, {
        ...platform,
        open: null,
        pending: false,
        closed_until: null,
        reason: 'outcome_unknown',
      })
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

  const describeReason = (reason: string | null | undefined, closureEndTime: string | null): string | null => {
    if (!reason) return null
    if (reason === REOPENS_AT_OPENING_REASON) {
      // The sentence is about the opening time; without a readable one, say
      // nothing rather than an incomplete "Opens automatically at".
      return closureEndTime
        ? t('settings.platforms.reason.reopensAtOpening', {
            time: closureEndTime,
            defaultValue: 'Opens automatically at {{time}}.',
          })
        : null
    }
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
          'efood opens automatically when the first cashier checks in and closes when the Z report is issued. Closing it here keeps it closed until the next check-in, unless you open it again.',
        )}
      </p>

      <PlatformNotificationSoundSettings />

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
            const awaitingProvider = isAwaitingProvider(platform)
            const closureExplained = hasClosureReason(platform)
            const showConfirmationLabel = awaitingProvider && !closureExplained
            // An accepted change that the provider has yet to reflect is not
            // an unconfirmed outcome, so it never carries the uncertainty banner.
            const isUncertain = Boolean(uncertain[platform.plugin_id]) && !awaitingProvider
            const closureEndTime =
              platform.open === false ? formatClosedUntil(platform.closed_until, i18n?.language) : null
            const reasonText = describeReason(platform.reason, closureEndTime)
            // A closure reason already explains the end (or deliberately hides a
            // safety bound), so the generic "Closed until" line is for the rest.
            const showClosedUntil = closureEndTime !== null && !awaitingProvider && !closureExplained
            const showExplicitActions = platform.controllable && platform.open === null
            const knownBefore = lastKnownOpen[platform.plugin_id]
            const showAcceptingOrders =
              platform.open === true && typeof platform.accepting_orders === 'boolean'
            const isEfood = platform.plugin_id === EFOOD_PLUGIN_ID
            const canManageEfoodSchedule = isEfood && platform.controllable
            const isScheduleOpen = weeklyScheduleOpenFor === platform.plugin_id

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
                    {showConfirmationLabel ? (
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
                        {platform.open
                          ? t('settings.platforms.status.opening', 'Opening…')
                          : t('settings.platforms.status.closing', 'Closing…')}
                      </span>
                    ) : (
                      <span className={`block text-xs font-semibold ${statusToneClass(platform.open)}`}>
                        {statusLabel(platform.open)}
                      </span>
                    )}
                    {showClosedUntil && (
                      <span className="block text-xs liquid-glass-modal-text-muted">
                        {t('settings.platforms.closedUntil', {
                          time: closureEndTime,
                          defaultValue: 'Closed until {{time}}',
                        })}
                      </span>
                    )}
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
                    {platform.open === false && platform.closure_status && (
                      <span className="block text-xs liquid-glass-modal-text-muted">
                        {t('settings.platforms.closureStatus', {
                          status: platform.closure_status,
                          defaultValue: 'efood status: {{status}}',
                        })}
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

                  {!platform.controllable && platform.open === null ? null : !platform.controllable ? (
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

                {canManageEfoodSchedule && (
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        setWeeklyScheduleOpenFor((current) =>
                          current === platform.plugin_id ? null : platform.plugin_id,
                        )
                      }
                      disabled={isPending}
                      className={liquidGlassModalButton('secondary', 'sm')}
                    >
                      {t('settings.platforms.weeklySchedule.action', 'Weekly hours')}
                    </button>
                  </div>
                )}

                {canManageEfoodSchedule && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      aria-pressed={efoodPartner.settings.enabled}
                      onClick={() => efoodPartner.updateSettings({ enabled: !efoodPartner.settings.enabled })}
                      className={`${liquidGlassModalButton('secondary', 'sm')} ${efoodPartner.settings.enabled ? 'ring-2 ring-yellow-400/70' : ''}`}
                    >
                      {t('settings.platforms.efoodPartner.pageToggle', 'efood page inside the POS')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={efoodPartner.settings.muted}
                      onClick={() => efoodPartner.updateSettings({ muted: !efoodPartner.settings.muted })}
                      className={`${liquidGlassModalButton('secondary', 'sm')} ${efoodPartner.settings.muted ? 'ring-2 ring-yellow-400/70' : ''}`}
                    >
                      {t('settings.platforms.efoodPartner.mute', 'Mute efood sounds')}
                    </button>
                    <span className="block w-full text-xs liquid-glass-modal-text-muted">
                      {t(
                        'settings.platforms.efoodPartner.help',
                        'efood keeps the shop closed unless its own app is connected. The POS keeps the efood Live Orders page running here, so no separate browser is needed: open it from the efood icon in the sidebar.',
                      )}
                    </span>
                  </div>
                )}

                {canManageEfoodSchedule && isScheduleOpen && (
                  <EfoodWeeklyScheduleEditor
                    onClose={() => setWeeklyScheduleOpenFor(null)}
                    parentActionPending={isPending}
                    isOnline={isOnline}
                    pendingSubmission={efoodPendingSchedule}
                    onPendingSubmissionChange={setEfoodPendingSchedule}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default PlatformsSection
