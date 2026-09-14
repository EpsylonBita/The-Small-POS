import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { posApiGet, posApiPost } from '../../utils/api-helpers'
import { liquidGlassModalButton } from '../../styles/designSystem'
import {
  EFOOD_ALL_DAY_INTERVAL,
  EFOOD_WEEK_DAYS,
  efoodDraftDaysEqual,
  efoodWeeklySchedulesEqual,
  extractEfoodScheduleErrorCode,
  sortEfoodDays,
  validateEfoodWeeklySchedule,
  type EfoodDaySchedule,
  type EfoodScheduleErrorCode,
  type EfoodWeekday,
} from '../../services/efoodWeeklySchedule'

interface EfoodScheduleGetBody {
  success?: boolean
  schedule?: { days?: unknown; checked_at?: string | null }
  error?: string
}

interface EfoodSchedulePostBody {
  success?: boolean
  status?: string
  schedule?: { days?: unknown; checked_at?: string | null }
  error?: string
}

const DAY_LABEL_DEFAULTS: Record<EfoodWeekday, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
}

const ERROR_MESSAGE_DEFAULTS: Record<EfoodScheduleErrorCode, { key: string; defaultValue: string }> = {
  provider_forbidden: {
    key: 'settings.platforms.weeklySchedule.errors.providerForbidden',
    defaultValue: 'efood has not permitted this change; contact support.',
  },
  invalid_schedule: {
    key: 'settings.platforms.weeklySchedule.errors.invalidSchedule',
    defaultValue: 'These hours could not be accepted. Check the schedule and try again.',
  },
  provider_unavailable: {
    key: 'settings.platforms.weeklySchedule.errors.providerUnavailable',
    defaultValue: 'efood is temporarily unavailable. Try again shortly.',
  },
  outcome_unknown: {
    key: 'settings.platforms.weeklySchedule.errors.outcomeUnknown',
    defaultValue: 'Could not confirm the result. Refresh to check the current schedule.',
  },
  production_not_connected: {
    key: 'settings.platforms.weeklySchedule.errors.productionNotConnected',
    defaultValue: 'This platform is not connected to a live store yet.',
  },
  wrong_terminal: {
    key: 'settings.platforms.weeklySchedule.errors.wrongTerminal',
    defaultValue: 'Manage this platform from its assigned register.',
  },
  module_disabled: {
    key: 'settings.platforms.weeklySchedule.errors.moduleDisabled',
    defaultValue: 'A required module is not enabled on this register.',
  },
  MODULE_REQUIRED: {
    key: 'settings.platforms.weeklySchedule.errors.moduleRequired',
    defaultValue: 'A required module is not enabled on this register.',
  },
}

const GENERIC_ERROR_DEFAULT = {
  key: 'settings.platforms.weeklySchedule.errors.generic',
  defaultValue: 'Something went wrong. Refresh to check the current schedule.',
}

function toDraft(days: EfoodDaySchedule[]): Record<EfoodWeekday, string[]> {
  const record = {} as Record<EfoodWeekday, string[]>
  for (const day of EFOOD_WEEK_DAYS) {
    const found = days.find((entry) => entry.day === day)
    record[day] = found ? [...found.times] : []
  }
  return record
}

function toApiDays(draft: Record<EfoodWeekday, string[]>): EfoodDaySchedule[] {
  return EFOOD_WEEK_DAYS.map((day) => ({ day, times: [...draft[day]] }))
}

/** Order-sensitive, non-filtering comparison so an in-progress (possibly invalid) edit always counts as dirty. */
function draftsEqualRaw(a: Record<EfoodWeekday, string[]>, b: Record<EfoodWeekday, string[]>): boolean {
  return efoodDraftDaysEqual(toApiDays(a), toApiDays(b))
}

interface EfoodWeeklyScheduleEditorProps {
  onClose: () => void
  parentActionPending: boolean
  isOnline: boolean
  /**
   * Lifted to the parent so a write attempt that has not yet been confirmed
   * applied survives closing and reopening this editor: it is the parent
   * (`PlatformsSection`), not this component's own lifecycle, that owns
   * whether a submission is still outstanding.
   */
  pendingSubmission: EfoodDaySchedule[] | null
  onPendingSubmissionChange: (days: EfoodDaySchedule[] | null) => void
}

export const EfoodWeeklyScheduleEditor: React.FC<EfoodWeeklyScheduleEditorProps> = ({
  onClose,
  parentActionPending,
  isOnline,
  pendingSubmission,
  onPendingSubmissionChange,
}) => {
  const { t } = useTranslation()

  const [isLoading, setIsLoading] = useState(isOnline)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [draft, setDraft] = useState<Record<EfoodWeekday, string[]> | null>(() => pendingSubmission ? toDraft(pendingSubmission) : null)
  const [baseline, setBaseline] = useState<Record<EfoodWeekday, string[]> | null>(() => pendingSubmission ? toDraft(pendingSubmission) : null)
  const [dirty, setDirty] = useState(false)
  const [staleServerDraft, setStaleServerDraft] = useState<Record<EfoodWeekday, string[]> | null>(null)
  const [justConfirmed, setJustConfirmed] = useState(false)

  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const waitingConfirmation = pendingSubmission !== null

  const mountedRef = useRef(true)
  const loadGenerationRef = useRef(0)
  const savePendingRef = useRef(false)

  // Refs mirroring the latest render's values so the async `load()` reads
  // *current* state at response time, not the value captured in its closure
  // when the request was fired (which could be stale by the time it resumes
  // after `await`, e.g. if the user edited the draft or a save completed
  // meanwhile).
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const pendingSubmissionRef = useRef(pendingSubmission)
  pendingSubmissionRef.current = pendingSubmission
  const baselineRef = useRef(baseline)
  baselineRef.current = baseline

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const myGeneration = ++loadGenerationRef.current
    let response: Awaited<ReturnType<typeof posApiGet<EfoodScheduleGetBody>>>
    try {
      response = await posApiGet<EfoodScheduleGetBody>('/pos/platforms/efood/schedule')
    } catch {
      response = { success: false }
    }
    // A newer load (explicit refresh) or a save that invalidated in-flight
    // reads has superseded this response.
    if (!mountedRef.current || myGeneration !== loadGenerationRef.current) return

    const body = response.data
    const days = body?.schedule?.days
    const validation = validateEfoodWeeklySchedule(days)
    const validDays = response.success && body?.success !== false && validation.valid

    if (!validDays) {
      setLoadFailed(true)
      setIsLoading(false)
      setIsRefreshing(false)
      return
    }

    const fetchedApiDays = sortEfoodDays(days as EfoodDaySchedule[])
    const fetchedDraft = toDraft(fetchedApiDays)
    setLoadFailed(false)

    const outstandingSubmission = pendingSubmissionRef.current
    if (outstandingSubmission) {
      // A write attempt is outstanding (accepted-pending or unknown outcome):
      // only an exact match with what we sent counts as confirmation. A
      // mismatch never overwrites the submitted/edited draft.
      if (efoodWeeklySchedulesEqual(fetchedApiDays, outstandingSubmission)) {
        setDraft(fetchedDraft)
        setBaseline(fetchedDraft)
        setDirty(false)
        setStaleServerDraft(null)
        onPendingSubmissionChange(null)
        setJustConfirmed(true)
      } else {
        setStaleServerDraft(fetchedDraft)
      }
      // else: keep showing the waiting banner; draft/baseline untouched.
    } else if (dirtyRef.current) {
      // Never silently discard unsaved edits on a background refresh.
      setStaleServerDraft(fetchedDraft)
    } else {
      setDraft(fetchedDraft)
      setBaseline(fetchedDraft)
      setStaleServerDraft(null)
    }

    setIsLoading(false)
    setIsRefreshing(false)
  }, [onPendingSubmissionChange])

  useEffect(() => {
    // Online-only: never dispatch a load while offline. If the editor opens
    // offline, the operator sees the offline notice and an explicit Refresh
    // once reconnected — no hidden retry.
    if (!isOnline) {
      setIsLoading(false)
      return
    }
    void load()
    // Only run once on mount; refresh is explicit thereafter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRefresh = () => {
    if (!isOnline || isRefreshing || isLoading || isSaving) return
    setJustConfirmed(false)
    setIsRefreshing(true)
    void load()
  }

  const handleDiscardAndReload = () => {
    if (!staleServerDraft || savePendingRef.current) return
    onPendingSubmissionChange(null)
    setDraft(staleServerDraft)
    setBaseline(staleServerDraft)
    setDirty(false)
    setStaleServerDraft(null)
  }

  const updateDay = (day: EfoodWeekday, times: string[]) => {
    if (!isOnline || savePendingRef.current || pendingSubmissionRef.current) return
    setDraft((current) => {
      if (!current) return current
      const next = { ...current, [day]: times }
      const currentBaseline = baselineRef.current
      setDirty(currentBaseline ? !draftsEqualRaw(next, currentBaseline) : true)
      return next
    })
  }

  const handleToggleClosed = (day: EfoodWeekday, closed: boolean) => {
    updateDay(day, closed ? [] : [EFOOD_ALL_DAY_INTERVAL])
  }

  const handleSetAllDay = (day: EfoodWeekday) => {
    updateDay(day, [EFOOD_ALL_DAY_INTERVAL])
  }

  const handleAddInterval = (day: EfoodWeekday) => {
    if (!draft) return
    updateDay(day, [...draft[day], ''])
  }

  const handleRemoveInterval = (day: EfoodWeekday, index: number) => {
    if (!draft) return
    updateDay(day, draft[day].filter((_, i) => i !== index))
  }

  const handleIntervalChange = (day: EfoodWeekday, index: number, part: 'from' | 'to', value: string) => {
    if (!draft) return
    const current = draft[day][index] || '-'
    const [from, to] = current.split('-')
    const nextInterval = part === 'from' ? `${value}-${to ?? ''}` : `${from ?? ''}-${value}`
    const next = draft[day].slice()
    next[index] = nextInterval
    updateDay(day, next)
  }

  const apiDays = draft ? toApiDays(draft) : null
  const validation = apiDays ? validateEfoodWeeklySchedule(apiDays) : { valid: false }

  const describeError = (error?: string | null): string => {
    const code = extractEfoodScheduleErrorCode(error)
    const entry = code ? ERROR_MESSAGE_DEFAULTS[code] : GENERIC_ERROR_DEFAULT
    return t(entry.key, entry.defaultValue)
  }

  const handleSave = async () => {
    if (!isOnline || parentActionPending || savePendingRef.current || !apiDays) return
    if (waitingConfirmation) return
    if (!validation.valid) return

    savePendingRef.current = true
    // A read already in flight cannot be allowed to land after this submit
    // and evaluate the old (pre-submit) state.
    loadGenerationRef.current += 1
    setIsRefreshing(false)
    setIsSaving(true)
    setSaveError(null)
    setJustConfirmed(false)

    try {
      const response = await posApiPost<EfoodSchedulePostBody>('/pos/platforms/efood/schedule', {
        days: apiDays,
      })
      const body = response.data

      if (response.success && body?.success !== false && body?.status === 'submitted') {
        // An accepted (202) write is not yet verified applied: this is
        // parent-owned state so it survives closing/reopening the editor,
        // and only an exact matching refresh clears it.
        onPendingSubmissionChange(apiDays)
        if (mountedRef.current) {
          setBaseline(draft)
          setDirty(false)
        }
        return
      }

      const code = extractEfoodScheduleErrorCode(response.error) || extractEfoodScheduleErrorCode(body?.error)
      if (code && code !== 'outcome_unknown') {
        if (mountedRef.current) setSaveError(describeError(response.error || body?.error))
        return
      }

      // Unrecognized/ambiguous outcome: never claim "saved". Require a
      // read-only refresh before another attempt so a duplicate is never
      // fired against an already-applied change.
      onPendingSubmissionChange(apiDays)
      if (mountedRef.current) setSaveError(null)
    } catch {
      onPendingSubmissionChange(apiDays)
      if (mountedRef.current) setSaveError(null)
    } finally {
      savePendingRef.current = false
      if (mountedRef.current) setIsSaving(false)
    }
  }

  const canSave = isOnline && !isSaving && !parentActionPending && !waitingConfirmation && validation.valid

  return (
    <div
      role="dialog"
      aria-label={t('settings.platforms.weeklySchedule.title', 'efood weekly hours')}
      className="rounded-xl border liquid-glass-modal-border bg-white/5 px-4 py-4 space-y-3 dark:bg-black/10"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block text-sm font-semibold liquid-glass-modal-text">
            {t('settings.platforms.weeklySchedule.title', 'efood weekly hours')}
          </span>
          <span className="block text-xs liquid-glass-modal-text-muted">
            {t(
              'settings.platforms.weeklySchedule.explain',
              'These hours repeat every week and only affect efood ordering hours. Overnight hours must be split across the two days they span.',
            )}
          </span>
        </div>
        <button
          type="button"
          aria-label={t('settings.platforms.weeklySchedule.close', 'Close')}
          onClick={onClose}
          className={liquidGlassModalButton('secondary', 'sm')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {!isOnline && (
        <p className="text-xs liquid-glass-modal-text-muted">
          {t('settings.platforms.weeklySchedule.offline', 'Reconnect to load or edit efood hours.')}
        </p>
      )}

      {waitingConfirmation && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <span className="text-sm liquid-glass-modal-text">
            {t(
              'settings.platforms.weeklySchedule.waitingConfirmation',
              'Waiting for efood to apply changes; refresh in a few minutes.',
            )}
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm liquid-glass-modal-text-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t('settings.platforms.weeklySchedule.loading', 'Loading efood hours...')}
        </div>
      ) : !isOnline && !draft ? null : loadFailed || !draft ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          <div className="space-y-2">
            <span className="block text-sm liquid-glass-modal-text">
              {t('settings.platforms.weeklySchedule.loadFailed', 'Could not load efood hours')}
            </span>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={!isOnline || isSaving}
              className={liquidGlassModalButton('secondary', 'sm')}
            >
              {t('settings.platforms.weeklySchedule.refresh', 'Refresh')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {staleServerDraft && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <div className="space-y-2">
                <span className="block text-sm liquid-glass-modal-text">
                  {t(
                    'settings.platforms.weeklySchedule.staleBanner',
                    'A newer schedule was loaded from efood. Reload to see it, or keep editing.',
                  )}
                </span>
                <button
                  type="button"
                  onClick={handleDiscardAndReload}
                  className={liquidGlassModalButton('secondary', 'sm')}
                >
                  {t('settings.platforms.weeklySchedule.discardReload', 'Discard my changes and reload')}
                </button>
              </div>
            </div>
          )}

          {justConfirmed && !waitingConfirmation && (
            <div className="flex items-start gap-3 rounded-xl border border-green-500/40 bg-green-500/10 px-4 py-3">
              <span className="text-sm liquid-glass-modal-text">
                {t('settings.platforms.weeklySchedule.confirmed', 'efood confirmed the new hours.')}
              </span>
            </div>
          )}

          {saveError && (
            <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
              <span className="text-sm liquid-glass-modal-text">{saveError}</span>
            </div>
          )}

          {!validation.valid && dirty && (
            <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
              <span className="text-sm liquid-glass-modal-text">
                {t(
                  'settings.platforms.weeklySchedule.validationError',
                  'Check the hours below: times must be HH:mm, end after start, and ranges cannot overlap.',
                )}
              </span>
            </div>
          )}

          <fieldset className="space-y-2" disabled={!isOnline || isSaving || waitingConfirmation || parentActionPending}>
            {EFOOD_WEEK_DAYS.map((day) => {
              const times = draft[day]
              const closed = times.length === 0
              return (
                <div
                  key={day}
                  data-testid={`efood-day-${day}`}
                  className="rounded-lg border liquid-glass-modal-border bg-white/5 px-3 py-2 space-y-2 dark:bg-gray-800/10"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium liquid-glass-modal-text">
                      {t(`settings.platforms.weeklySchedule.days.${day}`, DAY_LABEL_DEFAULTS[day])}
                    </span>
                    <label className="flex items-center gap-2 text-xs liquid-glass-modal-text-muted">
                      <input
                        type="checkbox"
                        checked={closed}
                        onChange={(event) => handleToggleClosed(day, event.target.checked)}
                      />
                      {t('settings.platforms.weeklySchedule.closed', 'Closed')}
                    </label>
                  </div>

                  {!closed && (
                    <div className="space-y-2">
                      {times.map((interval, index) => {
                        const [from = '', to = ''] = interval.split('-')
                        return (
                          <div key={index} className="flex flex-wrap items-center gap-2">
                            <label className="flex items-center gap-1 text-xs liquid-glass-modal-text-muted">
                              {t('settings.platforms.weeklySchedule.from', 'From')}
                              <input
                                type="text"
                                inputMode="numeric"
                                placeholder="HH:mm"
                                value={from}
                                aria-label={t('settings.platforms.weeklySchedule.from', 'From')}
                                onChange={(event) => handleIntervalChange(day, index, 'from', event.target.value)}
                                className="w-20 rounded-md border liquid-glass-modal-border bg-white/10 px-2 py-1 text-sm liquid-glass-modal-text dark:bg-black/20"
                              />
                            </label>
                            <label className="flex items-center gap-1 text-xs liquid-glass-modal-text-muted">
                              {t('settings.platforms.weeklySchedule.to', 'To')}
                              <input
                                type="text"
                                inputMode="numeric"
                                placeholder="HH:mm"
                                value={to}
                                aria-label={t('settings.platforms.weeklySchedule.to', 'To')}
                                onChange={(event) => handleIntervalChange(day, index, 'to', event.target.value)}
                                className="w-20 rounded-md border liquid-glass-modal-border bg-white/10 px-2 py-1 text-sm liquid-glass-modal-text dark:bg-black/20"
                              />
                            </label>
                            <button
                              type="button"
                              aria-label={t('settings.platforms.weeklySchedule.removeInterval', 'Remove hours')}
                              onClick={() => handleRemoveInterval(day, index)}
                              className={liquidGlassModalButton('secondary', 'sm')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )
                      })}
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => handleAddInterval(day)}
                          className={liquidGlassModalButton('secondary', 'sm')}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <Plus className="h-3.5 w-3.5" />
                            {t('settings.platforms.weeklySchedule.addInterval', 'Add hours')}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSetAllDay(day)}
                          className={liquidGlassModalButton('secondary', 'sm')}
                        >
                          {t('settings.platforms.weeklySchedule.allDay', 'All day (00:00–23:59)')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </fieldset>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={!isOnline || isRefreshing || isSaving}
              className={liquidGlassModalButton('secondary', 'sm')}
            >
              <span className="inline-flex items-center gap-2">
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                {t('settings.platforms.weeklySchedule.refresh', 'Refresh')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave}
              className={liquidGlassModalButton('primary', 'md')}
            >
              <span className="inline-flex items-center gap-2">
                {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('settings.platforms.weeklySchedule.save', 'Send to efood')}
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default EfoodWeeklyScheduleEditor
