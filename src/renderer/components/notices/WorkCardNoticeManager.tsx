import React, { useEffect, useState } from 'react'
import { toast } from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { useFeatures } from '../../hooks/useFeatures'
import { useWorkCardStatus } from '../../hooks/useWorkCardStatus'

const HOUR_MS = 60 * 60_000
const dismissed = new Map<string, number>()
export function WorkCardNoticeManager({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation()
  const features = useFeatures()
  const main = !features.loading && !features.isMobileWaiter && (features.isMainTerminal || !features.parentTerminalId)
  const status = useWorkCardStatus(enabled && main, [], true)
  const count = status.data?.enabled ? status.data.attention_count : 0
  const [revision, redraw] = useState(0)
  const dismissedUntil = dismissed.get(status.scope) ?? 0
  useEffect(() => {
    const remaining = dismissedUntil - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => { dismissed.delete(status.scope); redraw(n => n + 1) }, remaining)
    return () => clearTimeout(timer)
  }, [dismissedUntil, status.scope, revision])
  useEffect(() => {
    const id = `work-card-attention:${status.scope}`
    if (!enabled || !main || !count || Date.now() < dismissedUntil) {
      toast.remove(id)
      return
    }
    toast.custom(() => (
      <div role="status" aria-live="polite" data-cashier-recovery="true" data-testid="work-card-notice"
        className="pointer-events-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl border border-slate-300 bg-white p-4 text-sm text-slate-900 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
        <p>{t('workCard.attention', { count })}</p>
        <button type="button" className="mt-3 min-h-touch rounded-lg border border-slate-400 px-4 py-2 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-yellow-400"
          onClick={() => {
            const until = Date.now() + HOUR_MS
            dismissed.set(status.scope, until)
            redraw(n => n + 1)
            toast.remove(id)
          }}>{t('workCard.dismiss')}</button>
      </div>
    ), { id, duration: Infinity })
    return () => { toast.remove(id) }
  }, [count, enabled, main, status.scope, dismissedUntil, t])
  return null
}
