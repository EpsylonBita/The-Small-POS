/**
 * WaiterDevicesSection - Waiter-device management for the Settings modal.
 *
 * A MAIN terminal lists the mobile_waiter devices of its own terminal unit and
 * edits each device's allowed actions (enabled_features) through the
 * terminal-authenticated Admin API:
 *   GET /api/pos/terminals/waiter-devices
 *   PUT /api/pos/terminals/waiter-devices/{terminalId}
 *
 * Non-main callers receive 403 WAITER_MGMT_MAIN_ONLY from the server; the
 * section itself is already hidden for non-main terminals, but the denial is
 * still surfaced with friendly copy in case the terminal type changes
 * server-side while the modal is open.
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { Smartphone, RefreshCw, Loader2, ShieldAlert, AlertTriangle, Users } from 'lucide-react'
import { posApiGet, posApiPut } from '../../utils/api-helpers'
import { POSGlassSwitch } from '../ui/pos-glass-components'
import { liquidGlassModalButton } from '../../styles/designSystem'
import { formatDate } from '../../utils/format'

// The subset of enabled_features a main terminal manages from this screen.
// Keys mirror the server vocabulary in admin-dashboard pos-terminal-features.
const MANAGED_FEATURE_KEYS = [
  'order_creation',
  'table_management',
  'payment_processing',
  'refunds',
] as const

type ManagedFeatureKey = (typeof MANAGED_FEATURE_KEYS)[number]
type ManagedFeatureDraft = Record<ManagedFeatureKey, boolean>

interface WaiterDeviceStaff {
  staffId: string
  staffName: string | null
  roleType: string | null
  checkInTime: string | null
}

interface WaiterDevice {
  terminalId: string
  name: string | null
  location: string | null
  isActive: boolean
  online: boolean
  lastSeenAt: string | null
  enabledFeatures: Record<string, boolean>
  enabledModules: string[] | null
  activeStaff: WaiterDeviceStaff[]
}

interface WaiterDevicesListBody {
  success?: boolean
  data?: { devices?: WaiterDevice[] }
  total?: number
  error?: string
  code?: string
}

interface WaiterDeviceUpdateBody {
  success?: boolean
  data?: { enabled_features?: Record<string, boolean> }
  error?: string
  code?: string
}

/**
 * True when an API failure is the main-terminal-only denial. Both transports
 * carry the human message; the browser path additionally keeps the 403 body's
 * error text verbatim and the IPC path folds the JSON body (including the
 * WAITER_MGMT_MAIN_ONLY code) into the error string.
 */
export function isWaiterMgmtMainOnlyError(error: string | null | undefined): boolean {
  if (typeof error !== 'string') return false
  return (
    error.includes('WAITER_MGMT_MAIN_ONLY') ||
    error.includes('Only a main terminal can manage waiter devices')
  )
}

const buildDraft = (device: WaiterDevice): ManagedFeatureDraft => ({
  order_creation: device.enabledFeatures?.order_creation === true,
  table_management: device.enabledFeatures?.table_management === true,
  payment_processing: device.enabledFeatures?.payment_processing === true,
  refunds: device.enabledFeatures?.refunds === true,
})

const isDraftDirty = (device: WaiterDevice, draft: ManagedFeatureDraft): boolean =>
  MANAGED_FEATURE_KEYS.some((key) => draft[key] !== (device.enabledFeatures?.[key] === true))

export const WaiterDevicesSection: React.FC = () => {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<WaiterDevice[]>([])
  const [drafts, setDrafts] = useState<Record<string, ManagedFeatureDraft>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [savingTerminalId, setSavingTerminalId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mainOnlyDenied, setMainOnlyDenied] = useState(false)

  const loadDevices = useCallback(async (options?: { refresh?: boolean }) => {
    if (options?.refresh) {
      setIsRefreshing(true)
    } else {
      setIsLoading(true)
    }
    setLoadError(null)
    setMainOnlyDenied(false)

    try {
      const response = await posApiGet<WaiterDevicesListBody>('/api/pos/terminals/waiter-devices')
      const body = response.data

      if (response.success && body?.success !== false) {
        const list = Array.isArray(body?.data?.devices) ? body.data.devices : []
        setDevices(list)
        setDrafts(Object.fromEntries(list.map((device) => [device.terminalId, buildDraft(device)])))
        return
      }

      const message = body?.error || response.error || ''
      if (isWaiterMgmtMainOnlyError(message) || body?.code === 'WAITER_MGMT_MAIN_ONLY') {
        setMainOnlyDenied(true)
        return
      }
      setLoadError(
        message || t('settings.waiterDevices.loadFailed', 'Could not load waiter devices'),
      )
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [t])

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  const setDraftFeature = (terminalId: string, key: ManagedFeatureKey, next: boolean) => {
    setDrafts((current) => {
      const device = devices.find((entry) => entry.terminalId === terminalId)
      const base = current[terminalId] ?? (device ? buildDraft(device) : null)
      if (!base) return current
      return { ...current, [terminalId]: { ...base, [key]: next } }
    })
  }

  const handleSave = async (device: WaiterDevice) => {
    const draft = drafts[device.terminalId] ?? buildDraft(device)
    // Send the full record with the managed keys applied so unmanaged keys
    // (cash_drawer, discounts, ...) are preserved verbatim.
    const nextFeatures: Record<string, boolean> = { ...device.enabledFeatures }
    for (const key of MANAGED_FEATURE_KEYS) {
      nextFeatures[key] = draft[key]
    }
    // Server-side, payment_processing is normalized to cash_payments ||
    // card_payments, so the umbrella toggle must drive the concrete methods.
    // OFF zeroes both; ON restores the device's previous cash/card mix so an
    // admin-disabled method (e.g. cash off, card on) is not silently
    // re-enabled — only when both were off does ON enable both.
    if (draft.payment_processing !== (device.enabledFeatures?.payment_processing === true)) {
      if (!draft.payment_processing) {
        nextFeatures.cash_payments = false
        nextFeatures.card_payments = false
      } else {
        const previousCash = device.enabledFeatures?.cash_payments === true
        const previousCard = device.enabledFeatures?.card_payments === true
        if (previousCash || previousCard) {
          nextFeatures.cash_payments = previousCash
          nextFeatures.card_payments = previousCard
        } else {
          nextFeatures.cash_payments = true
          nextFeatures.card_payments = true
        }
      }
    }

    setSavingTerminalId(device.terminalId)
    try {
      const response = await posApiPut<WaiterDeviceUpdateBody>(
        `/api/pos/terminals/waiter-devices/${encodeURIComponent(device.terminalId)}`,
        { enabled_features: nextFeatures },
      )
      const body = response.data

      if (response.success && body?.success !== false) {
        const savedFeatures =
          body?.data?.enabled_features && typeof body.data.enabled_features === 'object'
            ? body.data.enabled_features
            : nextFeatures
        setDevices((current) =>
          current.map((entry) =>
            entry.terminalId === device.terminalId
              ? { ...entry, enabledFeatures: savedFeatures }
              : entry,
          ),
        )
        setDrafts((current) => ({
          ...current,
          [device.terminalId]: buildDraft({ ...device, enabledFeatures: savedFeatures }),
        }))
        toast.success(t('settings.waiterDevices.saved', 'Waiter device updated'))
        return
      }

      const message = body?.error || response.error || ''
      if (isWaiterMgmtMainOnlyError(message) || body?.code === 'WAITER_MGMT_MAIN_ONLY') {
        setMainOnlyDenied(true)
        return
      }
      toast.error(
        message || t('settings.waiterDevices.saveFailed', 'Could not save changes'),
      )
    } finally {
      setSavingTerminalId(null)
    }
  }

  const formatLastSeen = (value: string | null): string => {
    if (!value) return t('sync.time.never', 'Never')
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return t('sync.time.never', 'Never')
    const diffMins = Math.floor((Date.now() - date.getTime()) / 60000)
    if (diffMins < 1) return t('sync.time.justNow', 'just now')
    if (diffMins < 60) {
      return t('sync.time.minutesAgo', {
        minutes: diffMins,
        defaultValue: '{{minutes}} minutes ago',
      })
    }
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) {
      return t('sync.time.hoursAgo', { hours: diffHours, defaultValue: '{{hours}} hours ago' })
    }
    return formatDate(date)
  }

  const featureLabels: Record<ManagedFeatureKey, string> = {
    order_creation: t('settings.waiterDevices.features.order_creation', 'Take orders'),
    table_management: t('settings.waiterDevices.features.table_management', 'Manage tables'),
    payment_processing: t('settings.waiterDevices.features.payment_processing', 'Take payments'),
    refunds: t('settings.waiterDevices.features.refunds', 'Refunds'),
  }

  const describeStaff = (staff: WaiterDeviceStaff): string => {
    const name = staff.staffName?.trim() || staff.staffId
    const role = staff.roleType?.trim()
    return role ? `${name} (${role})` : name
  }

  return (
    <div
      id="settings-section-waiter-devices"
      className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-black/10 px-4 py-4 space-y-4 transition-all"
    >
      {/* Header row — mirrors the modal's sectionHeader chip, plus Refresh. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-yellow-400 text-black ring-1 ring-yellow-500/55 shadow-[0_8px_20px_rgba(250,204,21,0.22)]">
            <Smartphone className="h-5 w-5 text-black" />
          </span>
          <div className="min-w-0">
            <span className="block font-semibold liquid-glass-modal-text">
              {t('settings.waiterDevices.title', 'Waiter Devices')}
            </span>
            <span className="block text-xs liquid-glass-modal-text-muted">
              {t(
                'settings.waiterDevices.helpText',
                'Mobile waiter devices paired to this register',
              )}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadDevices({ refresh: true })}
          disabled={isLoading || isRefreshing}
          className={liquidGlassModalButton('secondary', 'md')}
        >
          <span className="inline-flex items-center gap-2">
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {t('settings.waiterDevices.refresh', 'Refresh')}
          </span>
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm liquid-glass-modal-text-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t('settings.waiterDevices.loading', 'Loading waiter devices...')}
        </div>
      ) : mainOnlyDenied ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <span className="text-sm liquid-glass-modal-text">
            {t(
              'settings.waiterDevices.mainOnly',
              'Only the main terminal can manage waiter devices.',
            )}
          </span>
        </div>
      ) : loadError ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          <span className="text-sm liquid-glass-modal-text">{loadError}</span>
        </div>
      ) : devices.length === 0 ? (
        <div className="rounded-xl border liquid-glass-modal-border bg-white/5 px-4 py-8 text-center dark:bg-black/10">
          <Smartphone className="mx-auto mb-2 h-8 w-8 opacity-40 liquid-glass-modal-text-muted" />
          <p className="text-sm font-medium liquid-glass-modal-text">
            {t('settings.waiterDevices.empty', 'No waiter devices paired')}
          </p>
          <p className="mt-1 text-xs liquid-glass-modal-text-muted">
            {t(
              'settings.waiterDevices.emptyHelp',
              'Pair a mobile waiter device from the admin dashboard to manage it here.',
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {devices.map((device) => {
            const draft = drafts[device.terminalId] ?? buildDraft(device)
            const dirty = isDraftDirty(device, draft)
            const saving = savingTerminalId === device.terminalId
            return (
              <div
                key={device.terminalId}
                className={`rounded-xl border liquid-glass-modal-border bg-white/5 px-4 py-3 space-y-3 dark:bg-gray-800/10 ${
                  device.isActive ? '' : 'opacity-50'
                }`}
              >
                {/* Identity + liveness */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="block truncate font-medium liquid-glass-modal-text">
                      {device.name?.trim() || device.terminalId}
                    </span>
                    {device.location?.trim() ? (
                      <span className="block truncate text-xs liquid-glass-modal-text-muted">
                        {device.location}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!device.isActive && (
                      <span className="rounded-full border border-gray-500/40 bg-gray-500/10 px-2 py-0.5 text-xs liquid-glass-modal-text-muted">
                        {t('settings.waiterDevices.inactive', 'Inactive')}
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
                        device.online
                          ? 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400'
                          : 'border-gray-500/30 bg-gray-500/10 liquid-glass-modal-text-muted'
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          device.online ? 'bg-green-500' : 'bg-gray-400'
                        }`}
                      />
                      {device.online
                        ? t('settings.waiterDevices.online', 'Online')
                        : t('settings.waiterDevices.offline', 'Offline')}
                    </span>
                  </div>
                </div>
                {!device.online && (
                  <div className="text-xs liquid-glass-modal-text-muted">
                    {t('settings.waiterDevices.lastSeen', {
                      time: formatLastSeen(device.lastSeenAt),
                      defaultValue: 'Last seen {{time}}',
                    })}
                  </div>
                )}

                {/* Currently checked-in staff */}
                <div className="flex items-start gap-2 text-xs liquid-glass-modal-text-muted">
                  <Users className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-words">
                    {device.activeStaff.length > 0
                      ? t('settings.waiterDevices.activeStaff', {
                          names: device.activeStaff.map(describeStaff).join(', '),
                          defaultValue: 'Checked in: {{names}}',
                        })
                      : t('settings.waiterDevices.noActiveStaff', 'No staff checked in')}
                  </span>
                </div>

                {/* Allowed-action toggles */}
                <div className="space-y-1 border-t border-white/10 pt-2">
                  <span className="block pb-1 text-xs font-semibold uppercase tracking-wide liquid-glass-modal-text-muted">
                    {t('settings.waiterDevices.features.title', 'Allowed actions')}
                  </span>
                  {MANAGED_FEATURE_KEYS.map((key) => (
                    <div key={key} className="flex items-center justify-between gap-3">
                      <span
                        id={`waiter-device-${device.terminalId}-${key}-label`}
                        className="text-sm liquid-glass-modal-text"
                      >
                        {featureLabels[key]}
                      </span>
                      <POSGlassSwitch
                        aria-labelledby={`waiter-device-${device.terminalId}-${key}-label`}
                        checked={draft[key]}
                        disabled={saving}
                        onChange={(next) => setDraftFeature(device.terminalId, key, next)}
                      />
                    </div>
                  ))}
                </div>

                {/* Save */}
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => void handleSave(device)}
                    disabled={!dirty || saving}
                    className={liquidGlassModalButton('primary', 'md')}
                  >
                    <span className="inline-flex items-center gap-2">
                      {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                      {saving
                        ? t('settings.waiterDevices.saving', 'Saving...')
                        : t('settings.waiterDevices.save', 'Save')}
                    </span>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default WaiterDevicesSection
