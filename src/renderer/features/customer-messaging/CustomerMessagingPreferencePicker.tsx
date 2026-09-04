import { useTranslation } from 'react-i18next'

import type { CustomerMessagingPosWorkspace } from '../../../shared/types/customer-messaging'

export interface CustomerMessagingPreferenceSelection {
  decision: 'allow' | 'deny' | 'no_preference'
  channel: 'sms' | 'whatsapp' | null
  connectionId: string | null
}

interface CustomerMessagingPreferencePickerProps {
  workspace: CustomerMessagingPosWorkspace
  busy: boolean
  onSelect: (selection: CustomerMessagingPreferenceSelection) => void
}

export function CustomerMessagingPreferencePicker({
  workspace,
  busy,
  onSelect,
}: CustomerMessagingPreferencePickerProps) {
  const { t } = useTranslation()
  if (!workspace.permissions.link || workspace.operationalLocked) return null

  return (
    <fieldset className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-white/10">
      <legend className="px-1 text-sm font-semibold">{t('customerMessaging.preferenceTitle')}</legend>
      <p className="text-sm text-slate-600 dark:text-zinc-400">{t('customerMessaging.preferenceDescription')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="min-h-11 rounded-xl border px-4" disabled={busy}
          onClick={() => onSelect({ decision: 'no_preference', channel: null, connectionId: null })}>
          {t('customerMessaging.preferenceNoPreference')}
        </button>
        <button type="button" className="min-h-11 rounded-xl border px-4" disabled={busy}
          onClick={() => onSelect({ decision: 'deny', channel: null, connectionId: null })}>
          {t('customerMessaging.preferenceDeny')}
        </button>
        {workspace.preferenceTargets.map(target => (
          <button key={`${target.channel}-${target.connectionId ?? 'direct'}`} type="button"
            className="min-h-11 rounded-xl border px-4" disabled={busy}
            onClick={() => onSelect({
              decision: 'allow',
              channel: target.channel,
              connectionId: target.connectionId,
            })}>
            {t(target.channel === 'sms'
              ? 'customerMessaging.preferenceSms'
              : 'customerMessaging.preferenceWhatsApp')}
          </button>
        ))}
      </div>
    </fieldset>
  )
}
