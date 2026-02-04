import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CreditCard,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  X,
} from 'lucide-react'
import { formatCurrency } from '../../utils/format'

type TransactionStatus =
  | 'pending'
  | 'processing'
  | 'approved'
  | 'declined'
  | 'error'
  | 'timeout'
  | 'cancelled'

interface TransactionResponse {
  transactionId: string
  status: TransactionStatus
  authorizationCode?: string
  cardType?: string
  cardLastFour?: string
  errorMessage?: string
}

interface Props {
  isOpen: boolean
  amount: number
  currency?: string
  onClose: () => void
  onComplete: (response: TransactionResponse) => void
  onCancel: () => void
  processPayment: (amount: number) => Promise<TransactionResponse>
}

export const PaymentDialog: React.FC<Props> = ({
  isOpen,
  amount,
  currency = 'EUR',
  onClose,
  onComplete,
  onCancel,
  processPayment,
}) => {
  const { t } = useTranslation()
  const [status, setStatus] = useState<TransactionStatus>('pending')
  const [message, setMessage] = useState('')
  const [response, setResponse] = useState<TransactionResponse | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)

  const formatAmount = (cents: number) => formatCurrency(cents / 100, currency)

  const handleProcess = useCallback(async () => {
    if (isProcessing) return

    setIsProcessing(true)
    setStatus('processing')
    setMessage(t('ecr.payment.presentCard', 'Please present card...'))

    try {
      const result = await processPayment(amount)
      setResponse(result)
      setStatus(result.status)

      if (result.status === 'approved') {
        setMessage(t('ecr.payment.approved', 'Payment approved'))
        setTimeout(() => {
          onComplete(result)
        }, 2000)
      } else {
        setMessage(result.errorMessage || t('ecr.payment.failed', 'Payment failed'))
      }
    } catch (error) {
      setStatus('error')
      setMessage(
        error instanceof Error
          ? error.message
          : t('ecr.payment.error', 'An error occurred')
      )
    } finally {
      setIsProcessing(false)
    }
  }, [amount, isProcessing, onComplete, processPayment, t])

  const handleCancel = () => {
    if (isProcessing) {
      onCancel()
    }
    onClose()
  }

  useEffect(() => {
    if (isOpen && status === 'pending') {
      handleProcess()
    }
  }, [isOpen, status, handleProcess])

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setStatus('pending')
      setMessage('')
      setResponse(null)
      setIsProcessing(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  const statusIcons: Record<TransactionStatus, React.ReactNode> = {
    pending: <CreditCard className="w-16 h-16 text-gray-400" />,
    processing: <Loader2 className="w-16 h-16 text-blue-400 animate-spin" />,
    approved: <CheckCircle className="w-16 h-16 text-green-400" />,
    declined: <XCircle className="w-16 h-16 text-red-400" />,
    error: <AlertTriangle className="w-16 h-16 text-red-400" />,
    timeout: <AlertTriangle className="w-16 h-16 text-yellow-400" />,
    cancelled: <XCircle className="w-16 h-16 text-gray-400" />,
  }

  const statusColors: Record<TransactionStatus, string> = {
    pending: 'text-gray-300',
    processing: 'text-blue-400',
    approved: 'text-green-400',
    declined: 'text-red-400',
    error: 'text-red-400',
    timeout: 'text-yellow-400',
    cancelled: 'text-gray-400',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={status !== 'processing' ? handleCancel : undefined}
      />

      {/* Dialog */}
      <div className="relative w-full max-w-md mx-4 p-8 rounded-2xl bg-gradient-to-br from-gray-800/95 to-gray-900/95 backdrop-blur-lg border border-gray-700/50 shadow-2xl">
        {/* Close button */}
        {status !== 'processing' && (
          <button
            onClick={handleCancel}
            className="absolute top-4 right-4 p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}

        {/* Content */}
        <div className="flex flex-col items-center text-center">
          {/* Icon */}
          <div className="mb-6">{statusIcons[status]}</div>

          {/* Amount */}
          <div className="text-4xl font-bold text-white mb-2">
            {formatAmount(amount)}
          </div>

          {/* Status message */}
          <p className={`text-lg mb-6 ${statusColors[status]}`}>{message}</p>

          {/* Card info (if approved) */}
          {status === 'approved' && response && (
            <div className="w-full p-4 rounded-lg bg-gray-700/50 mb-6">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">
                  {t('ecr.payment.card', 'Card')}
                </span>
                <span className="text-white font-mono">
                  {response.cardType} •••• {response.cardLastFour}
                </span>
              </div>
              {response.authorizationCode && (
                <div className="flex items-center justify-between text-sm mt-2">
                  <span className="text-gray-400">
                    {t('ecr.payment.authCode', 'Auth Code')}
                  </span>
                  <span className="text-white font-mono">
                    {response.authorizationCode}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          {status === 'processing' ? (
            <button
              onClick={handleCancel}
              className="w-full py-3 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors font-medium"
            >
              {t('ecr.payment.cancel', 'Cancel')}
            </button>
          ) : status === 'approved' ? (
            <button
              onClick={() => onComplete(response!)}
              className="w-full py-3 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors font-medium"
            >
              {t('common.done', 'Done')}
            </button>
          ) : (
            <div className="flex gap-3 w-full">
              <button
                onClick={handleProcess}
                className="flex-1 py-3 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors font-medium"
              >
                {t('ecr.payment.retry', 'Retry')}
              </button>
              <button
                onClick={handleCancel}
                className="flex-1 py-3 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-700 transition-colors font-medium"
              >
                {t('common.close', 'Close')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
