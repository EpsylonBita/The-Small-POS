import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WaiterServiceRequest } from '../../../../../shared/types/waiter-service-request'
import type { useWaiterServiceInbox } from '../../hooks/useWaiterServiceInbox'

export function MainServiceResolutionActions({ request, inbox }: {
  request: WaiterServiceRequest; inbox: ReturnType<typeof useWaiterServiceInbox>
}) {
  const { t } = useTranslation()
  const [recipient, setRecipient] = useState(''), [reason, setReason] = useState('')
  const intent = inbox.resolutions?.[request.id]
  const pending = !!intent && !intent.refusal
  const disabled = inbox.busy || inbox.stale || !inbox.canResolve || pending
  const waiters = (inbox.waiters || []).filter(w => w.id !== request.recipient_staff_id && w.id !== inbox.recipientStaffId)
  const button = 'min-h-12 rounded-lg border px-4 py-3 text-left disabled:opacity-50'
  return <div className="space-y-3" data-testid="main-service-actions">
    <p>{t('waiterService.mainResolutionHelp')}</p>
    {intent?.refusal && <p role="alert">{t('waiterService.resolutionRefused')}</p>}
    {pending ? <p role="status">{t('waiterService.awaitingDelivery')}</p> : <>
      <select data-testid="main-service-recipient" aria-label={t('waiterService.chooseWaiter')}
        value={recipient} onChange={e => setRecipient(e.target.value)} disabled={disabled}
        className="min-h-12 w-full rounded-lg border bg-white px-3 text-gray-900 dark:bg-gray-800 dark:text-white">
        <option value="">{t('waiterService.chooseWaiter')}</option>
        {waiters.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
      <button data-testid="main-service-reassign" className={button} disabled={disabled || !waiters.some(w => w.id === recipient)}
        onClick={() => { void inbox.resolve(request.id, 'reassign', recipient) }}>{t('waiterService.reassign')}</button>
      <div className="grid gap-3 sm:grid-cols-2">
        {request.kind === 'append_items' && <button data-testid="main-service-items" className={button} disabled={disabled}
          onClick={() => { void inbox.resolve(request.id, 'main_items') }}>{t('waiterService.takeItems')}</button>}
      </div>
      <label className="block">{t('waiterService.rejectionReason')}
        <textarea data-testid="main-service-reason" value={reason} maxLength={500} disabled={disabled}
          onChange={e => setReason(e.target.value)} className="mt-2 min-h-20 w-full rounded-lg border bg-white p-3 text-gray-900 dark:bg-gray-800 dark:text-white" />
      </label>
      <p>{t('waiterService.finalRejectHelp')}</p>
      <button data-testid="main-service-final-reject" className={`${button} bg-red-700 text-white`} disabled={disabled || !reason.trim()}
        onClick={() => { void inbox.resolve(request.id, 'reject_final', null, reason.trim()) }}>{t('waiterService.finalReject')}</button>
    </>}
  </div>
}
