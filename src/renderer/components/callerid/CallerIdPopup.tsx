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
          onClick={() => toast.dismiss(toastId)}
          className="flex-shrink-0 p-1 rounded hover:bg-white/10 transition-colors"
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
              onClick={() => {
                toast.dismiss(toastId)
                onViewCustomer?.(event.customer!.id)
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-white/10 hover:bg-white/20 text-zinc-200 transition-colors"
            >
              <User className="w-3.5 h-3.5" />
              {t('callerid.popup.viewCustomer', 'View')}
            </button>
            <button
              onClick={() => {
                toast.dismiss(toastId)
                onStartOrder?.(event)
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-green-600 hover:bg-green-500 text-white transition-colors"
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              {t('callerid.popup.startOrder', 'Start Order')}
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              toast.dismiss(toastId)
              onAddCustomer?.(event.callerNumber)
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors"
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
