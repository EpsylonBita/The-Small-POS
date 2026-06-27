/**
 * CallerIdPopup — Toast notification for incoming VoIP calls.
 *
 * Shows a non-blocking toast (top-right, 15s auto-dismiss) with caller info.
 * Known customers get "View Customer" + "Start Order" buttons.
 * Unknown callers get "Add Customer" button.
 */
import React from 'react'
import { toast } from 'react-hot-toast'
import { PhoneIncoming, User, ShoppingCart, UserPlus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CallerIdBroadcastEvent } from '../../services/CallerIdRealtimeService'

/** Duration before auto-dismiss (ms) */
const TOAST_DURATION = 15_000

interface CallerIdToastContentProps {
  event: CallerIdBroadcastEvent
  toastId: string
  onStartOrder?: (event: CallerIdBroadcastEvent) => void
  onViewCustomer?: (customerId: string) => void
  onAddCustomer?: (phone: string) => void
}

function CallerIdToastContent({
  event,
  toastId,
  onStartOrder,
  onViewCustomer,
  onAddCustomer,
}: CallerIdToastContentProps) {
  const { t } = useTranslation()
  const hasCustomer = event.customer && event.customer.id
  const displayName =
    (hasCustomer && event.customer?.name) ||
    event.callerName ||
    t('callerid.popup.unknownCaller', 'Unknown Caller')

  return (
    <div className="flex flex-col gap-2 min-w-[280px] max-w-[360px]">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
          <PhoneIncoming className="w-5 h-5 text-green-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">
            {displayName}
          </p>
          <p className="text-xs text-zinc-400 font-mono">{event.callerNumber}</p>
        </div>
        <button
          type="button"
          onClick={() => toast.dismiss(toastId)}
          aria-label={t('common.actions.close', 'Close')}
          className="flex-shrink-0 rounded-lg p-1 transition-transform active:scale-95 active:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80"
        >
          <X className="w-4 h-4 text-zinc-500" />
        </button>
      </div>

      {/* Customer info (if known) */}
      {hasCustomer && event.customer!.address && (
        <p className="text-xs text-zinc-400 truncate pl-[52px]">
          {event.customer!.address}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-2 pl-[52px]">
        {hasCustomer ? (
          <>
            <button
              type="button"
              onClick={() => {
                toast.dismiss(toastId)
                onViewCustomer?.(event.customer!.id)
              }}
              className="flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-transform active:scale-[0.98] active:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80"
            >
              <User className="w-3.5 h-3.5" />
              {t('callerid.popup.viewCustomer', 'View')}
            </button>
            <button
              type="button"
              onClick={() => {
                toast.dismiss(toastId)
                onStartOrder?.(event)
              }}
              className="flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition-transform active:scale-[0.98] active:bg-green-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-300/80"
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              {t('callerid.popup.startOrder', 'Start Order')}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              toast.dismiss(toastId)
              onAddCustomer?.(event.callerNumber)
            }}
            className="flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition-transform active:scale-[0.98] active:bg-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200"
          >
            <UserPlus className="w-3.5 h-3.5" />
            {t('callerid.popup.addCustomer', 'Add Customer')}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Show a caller ID toast notification.
 */
export function showCallerIdToast(
  event: CallerIdBroadcastEvent,
  options?: {
    onStartOrder?: (event: CallerIdBroadcastEvent) => void
    onViewCustomer?: (customerId: string) => void
    onAddCustomer?: (phone: string) => void
  },
) {
  const toastId = `callerid-${event.sipCallId}`

  toast.custom(
    (t) => (
      <div
        className={`${
          t.visible ? 'animate-enter' : 'animate-leave'
        } pointer-events-auto rounded-xl p-4 shadow-2xl border border-white/10`}
        style={{
          background: 'rgba(24, 24, 27, 0.92)',
          backdropFilter: 'blur(16px)',
        }}
      >
        <CallerIdToastContent
          event={event}
          toastId={toastId}
          onStartOrder={options?.onStartOrder}
          onViewCustomer={options?.onViewCustomer}
          onAddCustomer={options?.onAddCustomer}
        />
      </div>
    ),
    {
      id: toastId,
      duration: TOAST_DURATION,
      position: 'top-right',
    },
  )
}
