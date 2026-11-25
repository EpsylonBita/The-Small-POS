import { boxAvailabilityFeedbackEnglish, boxAvailabilityFeedbackKey } from '../../../../../shared/platforms/box-availability-error'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import {
  BOX_WEEKDAYS,
  isValidBoxWeeklySchedule,
  type BoxWeekday,
  type BoxWeeklySchedule,
} from '../../../../../shared/platforms/box-weekly-schedule'
import { solidButton, useReportSettingsDirty } from './SettingsKit'

export type BoxScheduleSaveResult = 'saved' | 'conflict' | 'busy' | 'provider_rejected' | 'provider_forbidden' | 'failed'

interface Props {
  provider?: 'box' | 'wolt'
  schedule: BoxWeeklySchedule | null
  savedAt: string | null
  revision?: string
  disabled: boolean
  detailUnavailable: boolean
  providerPending?: boolean
  save: (week: BoxWeeklySchedule, revision: string) => Promise<BoxScheduleSaveResult | undefined>
  reload: () => Promise<boolean | undefined>
}

type Draft = { days: Partial<BoxWeeklySchedule>; revision: string }

export function BoxWeeklyScheduleEditor({ provider = 'box', schedule, savedAt, revision, disabled, detailUnavailable, providerPending = false, save, reload }: Props) {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [failure, setFailure] = useState<Exclude<BoxScheduleSaveResult, 'saved'> | null>(null)
  const [reloading, setReloading] = useState(false)
  const days: Partial<BoxWeeklySchedule> = draft?.days ?? schedule ?? {}
  const wolt = provider === 'wolt'
  const requiresReload = wolt && (providerPending || failure === 'failed')
  const conflict = failure === 'conflict' || (draft !== null && draft.revision !== revision)
  const complete = BOX_WEEKDAYS.every(day => days[day] !== undefined)
  const valid = isValidBoxWeeklySchedule(days)
  const locked = disabled || reloading || !revision
  const failureKey = failure && boxAvailabilityFeedbackKey(failure)
  useReportSettingsDirty(`${provider}-schedule`, draft !== null)
  function updateDay(day: BoxWeekday, intervals: BoxWeeklySchedule[BoxWeekday] | undefined) {
    if (!revision) return
    setDraft(current => ({
      revision: current ? current.revision : revision,
      days: { ...(current?.days ?? schedule), [day]: intervals },
    }))
    if (!conflict && !requiresReload) setFailure(null)
  }

  async function submit() {
    if (locked || detailUnavailable || conflict || requiresReload || !draft || !isValidBoxWeeklySchedule(draft.days)) return
    const result = await save(draft.days, draft.revision)
    if (result === 'saved') {
      setDraft(null)
      setFailure(null)
    } else {
      setFailure(result ?? 'failed')
    }
  }

  async function discardAndReload() {
    setReloading(true)
    try {
      if (await reload()) {
        setDraft(null)
        setFailure(null)
      }
    } finally {
      setReloading(false)
    }
  }

  return (
    <div className="pos-row pos-row--stack">
      <div>
        <button type="button" className={solidButton('secondary', 'sm')} aria-expanded={expanded}
          disabled={locked || (!expanded && detailUnavailable)} onClick={() => setExpanded(!expanded)}>
          {t('settings.platforms.weeklySchedule.action', 'Weekly hours')}
        </button>
      </div>
      {expanded && (
        <div className="space-y-3" role="group" aria-label={wolt ? t('settings.platforms.wolt.title') : t('settings.platforms.box.hours.title', 'BOX weekly hours')}>
          <p className="pos-row__help">
            {wolt ? t('settings.platforms.wolt.explain') : t('settings.platforms.box.hours.explain', 'Saving replaces all seven days in BOX. Enter hours for each day or mark that no hours start that day.')}
          </p>
          <p className="pos-row__help" role="status">
            {wolt ? t('settings.platforms.wolt.live') : schedule && savedAt && Number.isFinite(Date.parse(savedAt))
              ? t('settings.platforms.box.hours.lastSent', {
                time: new Date(savedAt).toLocaleString(i18n?.language, { dateStyle: 'short', timeStyle: 'short' }),
                defaultValue: 'Last schedule sent from the POS · {{time}}. Changes made in BOX Merchant are not shown here.',
              })
              : t('settings.platforms.box.hours.noHistory', 'There are no hours on record from this POS system. BOX does not return its current schedule.')}
          </p>
          <fieldset className="space-y-2" disabled={locked}>
            {BOX_WEEKDAYS.map(day => {
              const intervals = days[day]
              const dayName = t(`settings.platforms.weeklySchedule.days.${day}`, day[0].toUpperCase() + day.slice(1))
              return (
                <fieldset key={day} className="space-y-2 rounded-lg border liquid-glass-modal-border px-3 py-2">
                  <legend className="pos-row__title px-1">{dayName}</legend>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={intervals?.length === 0}
                        onChange={event => updateDay(day, event.target.checked ? [] : undefined)} />
                      {t('settings.platforms.box.hours.noStart', 'No hours start this day')}
                    </label>
                    <button type="button" className={solidButton('secondary', 'sm')}
                      onClick={() => updateDay(day, [...(intervals ?? []), { from: '', to: '' }])}>
                      {t('settings.platforms.weeklySchedule.addInterval', 'Add hours')}
                    </button>
                  </div>
                  {intervals?.map((interval, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-2">
                      {(['from', 'to'] as const).map(field => (
                        <label key={field} className="flex items-center gap-1 text-sm">
                          {field === 'from' ? t('settings.platforms.weeklySchedule.from', 'From') : t('settings.platforms.weeklySchedule.to', 'To')}
                          <input type="text" placeholder="HH:mm" maxLength={5} value={interval[field]}
                            className="pos-glass-field w-20 rounded-md border px-2 py-1"
                            onChange={event => updateDay(day, intervals.map((item, i) =>
                              i === index ? { ...item, [field]: event.target.value } : item))} />
                        </label>
                      ))}
                      {/^([01]\d|2[0-3]):[0-5]\d$/.test(interval.to) && interval.to < interval.from && (
                        <span className="pos-row__help">{t('settings.platforms.box.hours.nextDay', 'Next day')}</span>
                      )}
                      <button type="button" className={solidButton('secondary', 'sm')}
                        aria-label={t('settings.platforms.weeklySchedule.removeInterval', 'Remove hours')}
                        onClick={() => updateDay(day, intervals.length === 1 ? undefined : intervals.filter((_, i) => i !== index))}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </fieldset>
              )
            })}
          </fieldset>

          {complete && !valid && (
            <p role="alert" className="pos-row__help">
              {t('settings.platforms.box.hours.invalid', 'Use HH:mm and check for overlapping hours, including the next day. Use 00:00–24:00 for a full day.')}
            </p>
          )}
          {failureKey && !conflict && !requiresReload && (
            <p role="alert" className="pos-row__help">
              {wolt && failure === 'provider_rejected' ? t('settings.platforms.wolt.refused') : t(failureKey, boxAvailabilityFeedbackEnglish[failureKey])}
            </p>
          )}
          {(conflict || requiresReload) && (
            <div className="space-y-1">
              <p role="alert" className="pos-row__help">
                {wolt ? t(requiresReload ? 'settings.platforms.wolt.unconfirmed' : 'settings.platforms.wolt.changed') : t('settings.platforms.box.hours.conflict', boxAvailabilityFeedbackEnglish['settings.platforms.box.hours.conflict'])}
              </p>
              <button type="button" className={solidButton('secondary', 'sm')} disabled={locked} onClick={() => void discardAndReload()}>
                {t('settings.platforms.weeklySchedule.discardReload', 'Discard my changes and reload')}
              </button>
            </div>
          )}
          <button type="button" className={solidButton('primary', 'md')} disabled={locked || detailUnavailable || !valid || !draft || conflict || requiresReload}
            onClick={() => void submit()}>
            {wolt ? t('settings.platforms.wolt.save') : t('settings.platforms.box.hours.save', 'Send week to BOX')}
          </button>
        </div>
      )}
    </div>
  )
}
