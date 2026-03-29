import React, { useEffect, useState } from 'react'
import { offEvent, onEvent } from '../../lib'
import { LiquidGlassModal, POSGlassButton } from './ui/pos-glass-components'
import { screenCaptureHandler } from '../services/ScreenCaptureHandler'

interface ControlRequestPayload {
  requestId: string
  requestedAt?: string | null
  terminalId?: string | null
}

const CONTROL_REQUEST_EVENT = 'screen-capture:control-request'
const CONTROL_REQUEST_CLEARED_EVENT = 'screen-capture:control-request-cleared'

export const ScreenCaptureControlRequestModal: React.FC = () => {
  const [request, setRequest] = useState<ControlRequestPayload | null>(null)
  const [processing, setProcessing] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handleRequest = (payload: ControlRequestPayload) => {
      if (!payload?.requestId) {
        return
      }

      setRequest(payload)
      setProcessing(null)
      setError(null)
    }

    const handleRequestCleared = () => {
      setRequest(null)
      setProcessing(null)
      setError(null)
    }

    onEvent(CONTROL_REQUEST_EVENT, handleRequest)
    onEvent(CONTROL_REQUEST_CLEARED_EVENT, handleRequestCleared)

    return () => {
      offEvent(CONTROL_REQUEST_EVENT, handleRequest)
      offEvent(CONTROL_REQUEST_CLEARED_EVENT, handleRequestCleared)
    }
  }, [])

  const handleApprove = async () => {
    setProcessing('approve')
    setError(null)

    try {
      await screenCaptureHandler.approvePendingControlRequest()
    } catch (err) {
      console.error('[ScreenCaptureControlRequestModal] Failed to approve control request', err)
      setError('Failed to approve the remote control request.')
      setProcessing(null)
    }
  }

  const handleDeny = async () => {
    setProcessing('deny')
    setError(null)

    try {
      await screenCaptureHandler.denyPendingControlRequest()
    } catch (err) {
      console.error('[ScreenCaptureControlRequestModal] Failed to deny control request', err)
      setError('Failed to deny the remote control request.')
      setProcessing(null)
    }
  }

  return (
    <LiquidGlassModal
      isOpen={Boolean(request)}
      onClose={() => {}}
      title="Remote Control Request"
      size="sm"
      closeOnBackdrop={false}
      closeOnEscape={false}
      ariaLabel="Remote control request"
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300/80">
          Admin requested control of this terminal. Approve to allow remote interaction for this
          session.
        </p>
        {request?.requestedAt ? (
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Requested at {new Date(request.requestedAt).toLocaleString()}
          </div>
        ) : null}
        {request?.terminalId ? (
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Terminal {request.terminalId}
          </div>
        ) : null}
        {error ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-700 dark:text-red-300">
            {error}
          </div>
        ) : null}
        <div className="flex gap-3">
          <POSGlassButton
            variant="secondary"
            fullWidth
            disabled={processing !== null}
            onClick={() => {
              void handleDeny()
            }}
          >
            {processing === 'deny' ? 'Denying...' : 'Deny'}
          </POSGlassButton>
          <POSGlassButton
            variant="primary"
            fullWidth
            disabled={processing !== null}
            onClick={() => {
              void handleApprove()
            }}
          >
            {processing === 'approve' ? 'Approving...' : 'Approve'}
          </POSGlassButton>
        </div>
      </div>
    </LiquidGlassModal>
  )
}
