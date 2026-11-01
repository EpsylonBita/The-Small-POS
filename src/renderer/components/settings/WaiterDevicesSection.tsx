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

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { Loader2, ShieldAlert, AlertTriangle, Users, ListChecks } from 'lucide-react'
import { posApiGet, posApiPut } from '../../utils/api-helpers'
import { POSGlassSwitch } from '../ui/pos-glass-components'
import { DirtyFooter, StatusLine, solidButton, useReportSettingsDirty } from './SettingsKit'
import { formatDate } from '../../utils/format'
import { SERVICE_OVERVIEW_OPEN_EVENT } from '../../../../../shared/pos/tables/WaiterServiceInbox'

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
  /** Satellite order-code marker (e.g. "M1") — prefixes this device's order numbers. */
  shortCode?: string | null
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

const WAITER_DEVICES_REFRESH_MS = 30_000

export const WaiterDevicesSection: React.FC = () => {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<WaiterDevice[]>([])
  const [drafts, setDrafts] = useState<Record<string, ManagedFeatureDraft>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  // One save for every changed phone (wave 7Δ2); switches wait while it runs.
  const [saving, setSaving] = useState(false)
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

  // Quiet refresh every 30 s instead of a Refresh button (one less thing to press).
  // It waits while the operator has unsaved access changes or a save is running,
  // because a reload replaces the drafts.
  const draftsDirty = devices.some((device) =>
    JSON.stringify(drafts[device.terminalId] ?? null) !== JSON.stringify(buildDraft(device)))
  // The settings shell asks before these unsaved permission changes are dropped.
  useReportSettingsDirty('waiter-devices', draftsDirty)
  const quietRefreshBlockedRef = useRef(false)
  quietRefreshBlockedRef.current = draftsDirty || saving
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (quietRefreshBlockedRef.current || document.visibilityState === 'hidden') return
      void loadDevices({ refresh: true })
    }, WAITER_DEVICES_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [loadDevices])

  const setDraftFeature = (terminalId: string, key: ManagedFeatureKey, next: boolean) => {
    setDrafts((current) => {
      const device = devices.find((entry) => entry.terminalId === terminalId)
      const base = current[terminalId] ?? (device ? buildDraft(device) : null)
      if (!base) return current
      return { ...current, [terminalId]: { ...base, [key]: next } }
    })
  }

  type SaveOutcome = { kind: 'saved' } | { kind: 'denied' } | { kind: 'failed'; message: string }

  const saveDevice = async (device: WaiterDevice): Promise<SaveOutcome> => {
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
      return { kind: 'saved' }
    }

    const message = body?.error || response.error || ''
    if (isWaiterMgmtMainOnlyError(message) || body?.code === 'WAITER_MGMT_MAIN_ONLY') {
      return { kind: 'denied' }
    }
    return { kind: 'failed', message }
  }

  // One «Αποθήκευση» for every changed phone, one PUT each, in order. A phone that fails keeps its
  // draft (the footer stays) so the operator can try again; the others are saved.
  const handleSaveAll = async () => {
    const changed = devices.filter((device) =>
      isDraftDirty(device, drafts[device.terminalId] ?? buildDraft(device)))
    if (changed.length === 0 || saving) return
    setSaving(true)
    let savedCount = 0
    const failures = new Set<string>()
    try {
      for (const device of changed) {
        let outcome: SaveOutcome
        try {
          outcome = await saveDevice(device)
        } catch (error) {
          outcome = { kind: 'failed', message: error instanceof Error ? error.message : '' }
        }
        if (outcome.kind === 'denied') {
          setMainOnlyDenied(true)
          return
        }
        if (outcome.kind === 'saved') savedCount += 1
        else failures.add(outcome.message)
      }
    } finally {
      setSaving(false)
    }
    if (savedCount > 0) {
      toast.success(savedCount === 1
        ? t('settings.waiterDevices.saved', 'Waiter device updated')
        : t('settings.waiterDevices.savedMany', 'Waiter phones updated'))
    }
    for (const message of failures) {
      toast.error(message || t('settings.waiterDevices.saveFailed', 'Could not save changes'))
    }
  }

  // Cancel: every phone back to what is saved.
  const resetDrafts = () => {
    setDrafts(Object.fromEntries(devices.map((device) => [device.terminalId, buildDraft(device)])))
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
    <div id="settings-section-waiter-devices" className="space-y-4">
      {/* The pane title (the rail label) names the section; this line only explains it. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm liquid-glass-modal-text-muted">
          {t(
            'settings.waiterDevices.helpText',
            'Mobile waiter devices paired to this register',
          )}
        </p>
        {/* The full service request list lives here; the floating chip only
            appears while a request needs someone (founder, 13/10/2026). */}
        <button
          type="button"
          data-testid="waiter-devices-service-requests"
          onClick={() => window.dispatchEvent(new CustomEvent(SERVICE_OVERVIEW_OPEN_EVENT))}
          className={solidButton('secondary', 'md')}
        >
          <ListChecks className="h-4 w-4" />
          {t('waiterService.requests')}
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm liquid-glass-modal-text-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t('settings.waiterDevices.loading', 'Loading waiter devices...')}
        </div>
      ) : mainOnlyDenied ? (
        <div className="pos-notice pos-notice--warn">
          <ShieldAlert className="pos-notice__icon h-5 w-5" />
          <span className="text-sm liquid-glass-modal-text">
            {t(
              'settings.waiterDevices.mainOnly',
              'Only the main terminal can manage waiter devices.',
            )}
          </span>
        </div>
      ) : loadError ? (
        <div role="alert" className="pos-notice pos-notice--bad">
          <AlertTriangle className="pos-notice__icon h-5 w-5" />
          <span className="text-sm">{loadError}</span>
        </div>
      ) : devices.length === 0 ? (
        <section className="pos-group">
          <div className="pos-row">
            <div className="pos-row__label">
              <span className="pos-row__title">{t('settings.waiterDevices.empty', 'No waiter devices paired')}</span>
              <span className="pos-row__help">
                {t(
                  'settings.waiterDevices.emptyHelp',
                  'Pair a mobile waiter device from the admin dashboard to manage it here.',
                )}
              </span>
            </div>
          </div>
        </section>
      ) : (
        <div className="space-y-4">
          {devices.map((device) => {
            const draft = drafts[device.terminalId] ?? buildDraft(device)
            return (
              <section key={device.terminalId} className="pos-group" data-waiter-device={device.terminalId}>
                {/* Identity, liveness and who is checked in */}
                <div className="pos-row">
                  <div className="pos-row__label">
                    <span className="pos-row__title flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate">{device.name?.trim() || device.terminalId}</span>
                      {device.shortCode?.trim() ? (
                        <span className="pos-badge">{device.shortCode.trim().toUpperCase()}</span>
                      ) : null}
                      {!device.isActive && (
                        <span className="pos-badge">{t('settings.waiterDevices.inactive', 'Inactive')}</span>
                      )}
                    </span>
                    {device.location?.trim() ? (
                      <span className="pos-row__help truncate">{device.location}</span>
                    ) : null}
                    <StatusLine tone={device.online ? 'ok' : 'idle'}>
                      {device.online
                        ? t('settings.waiterDevices.online', 'Online')
                        : `${t('settings.waiterDevices.offline', 'Offline')} · ${t('settings.waiterDevices.lastSeen', {
                            time: formatLastSeen(device.lastSeenAt),
                            defaultValue: 'Last seen {{time}}',
                          })}`}
                    </StatusLine>
                    <span className="pos-row__help mt-1 flex items-start gap-2">
                      <Users className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 wrap-break-word">
                        {device.activeStaff.length > 0
                          ? t('settings.waiterDevices.activeStaff', {
                              names: device.activeStaff.map(describeStaff).join(', '),
                              defaultValue: 'Checked in: {{names}}',
                            })
                          : t('settings.waiterDevices.noActiveStaff', 'No staff checked in')}
                      </span>
                    </span>
                  </div>
                </div>

                {/* Allowed actions: one kit row each; saved together by the footer below. */}
                <div className="border-t border-(--pos-s-border) [&>.pos-row:first-of-type]:border-t-0">
                  <p className="px-5 pt-3 text-sm font-semibold liquid-glass-modal-text-muted">
                    {t('settings.waiterDevices.features.title', 'Allowed actions')}
                  </p>
                  {MANAGED_FEATURE_KEYS.map((key) => (
                    <div key={key} className="pos-row">
                      <span
                        id={`waiter-device-${device.terminalId}-${key}-label`}
                        className="pos-row__title"
                      >
                        {featureLabels[key]}
                      </span>
                      <div className="pos-row__control">
                        <POSGlassSwitch
                          aria-labelledby={`waiter-device-${device.terminalId}-${key}-label`}
                          checked={draft[key]}
                          disabled={saving}
                          onChange={(next) => setDraftFeature(device.terminalId, key, next)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <DirtyFooter
        visible={draftsDirty}
        note={<span role="status">{t('settings.waiterDevices.unsavedNote', 'Unsaved access changes')}</span>}
        saveLabel={saving
          ? t('settings.waiterDevices.saving', 'Saving...')
          : t('settings.waiterDevices.save', 'Save')}
        cancelLabel={t('common.actions.cancel', 'Cancel')}
        onSave={() => void handleSaveAll()}
        onCancel={resetDrafts}
        saving={saving}
      />
    </div>
  )
}

export default WaiterDevicesSection
