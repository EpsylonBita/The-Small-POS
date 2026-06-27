import React, { useState, useEffect } from 'react'
import { LiquidGlassModal } from '../ui/pos-glass-components'
import { useTranslation } from 'react-i18next'
import { Delete as DeleteIcon, LockKeyhole, ShieldCheck } from 'lucide-react'

interface PINLoginModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (pin: string) => Promise<boolean> | boolean
  title?: string
  subtitle?: string
}

export const PINLoginModal: React.FC<PINLoginModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  title,
  subtitle,
}) => {
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { t } = useTranslation()
  const titleToShow = title ?? t('auth.login.title')
  const subtitleToShow = subtitle ?? t('auth.login.subtitle')
  const maskChar = '\u2022'
  const pinSlots = Array.from({ length: 6 }, (_, index) => index)

  const handleNumber = (n: string) => {
    if (pin.length < 6 && !loading) {
      setPin(prev => prev + n)
      setError('')
    }
  }

  const handleBack = () => {
    if (loading) return
    setPin(prev => prev.slice(0, -1))
    setError('')
  }

  const handleClear = () => {
    if (loading) return
    setPin('')
    setError('')
  }

  const handleSubmit = async () => {
    if (!pin || loading) {
      if (!pin) setError(t('auth.login.enterPin'))
      return
    }

    setLoading(true)
    try {
      const ok = await onSubmit(pin)
      if (!ok) setError(t('auth.login.error'))
    } catch (error: any) {
      setError(error?.message || t('auth.login.error'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!isOpen) {
      setPin('')
      setError('')
      setLoading(false)
      return
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (loading) return

      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return
      }

      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault()
        e.stopPropagation()
        handleNumber(e.key)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        handleBack()
      } else if (e.key === 'Delete') {
        e.preventDefault()
        e.stopPropagation()
        handleClear()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        handleSubmit()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isOpen, pin, loading])

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={titleToShow}
      size="sm"
      closeOnBackdrop={false}
      className="!max-w-[400px] max-h-[calc(100dvh-1.5rem)]"
      contentClassName="space-y-3"
    >
      <div className="rounded-2xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-2.5 text-emerald-950 shadow-sm shadow-emerald-950/5 dark:text-emerald-50">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
            <ShieldCheck size={16} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {t('auth.login.pinConfirmationRequired', 'PIN confirmation required')}
            </p>
            <p className="mt-1 text-sm leading-4 text-slate-700 dark:text-slate-200">
              {subtitleToShow}
            </p>
          </div>
        </div>
      </div>

      <div
        aria-label={t('auth.login.pinEntry', 'PIN entry')}
        className="rounded-2xl border border-slate-300 bg-white p-3 text-center shadow-inner dark:border-white/15 dark:bg-slate-950/80"
      >
        <div className="mb-2 flex items-center justify-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <LockKeyhole size={16} aria-hidden="true" />
          <span>{t('auth.login.enterPin', 'Enter PIN')}</span>
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {pinSlots.map(slot => {
            const filled = slot < pin.length

            return (
              <div
                key={slot}
                className={[
                  'flex h-9 items-center justify-center rounded-md border text-lg font-semibold',
                  filled
                    ? 'border-emerald-500 bg-emerald-500 text-white shadow-sm'
                    : 'border-slate-300 bg-slate-100 text-slate-400 dark:border-white/15 dark:bg-slate-900 dark:text-slate-500',
                ].join(' ')}
              >
                {filled ? maskChar : ''}
              </div>
            )
          })}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-2xl border border-red-400/50 bg-red-500/10 px-3 py-2 text-center text-sm font-semibold text-red-700 dark:text-red-200"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {[...'123456789'].map(n => (
          <button
            key={n}
            type="button"
            onClick={() => handleNumber(n)}
            disabled={loading}
            className="inline-flex min-h-[48px] items-center justify-center rounded-xl border border-slate-300 bg-white text-center text-lg font-semibold text-slate-950 shadow-sm transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/15 dark:bg-slate-900 dark:text-white"
          >
            {n}
          </button>
        ))}
        <button
          type="button"
          onClick={handleClear}
          disabled={loading || !pin}
          className="inline-flex min-h-[48px] items-center justify-center rounded-xl border border-slate-300 bg-white px-2 text-center text-sm font-semibold text-slate-800 shadow-sm transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-slate-900 dark:text-slate-100"
        >
          {t('common.clear', 'Clear')}
        </button>
        <button
          type="button"
          onClick={() => handleNumber('0')}
          disabled={loading}
          className="inline-flex min-h-[48px] items-center justify-center rounded-xl border border-slate-300 bg-white text-center text-lg font-semibold text-slate-950 shadow-sm transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/15 dark:bg-slate-900 dark:text-white"
        >
          0
        </button>
        <button
          type="button"
          onClick={handleBack}
          disabled={loading || !pin}
          aria-label={t('common.actions.backspace', 'Backspace')}
          className="inline-flex min-h-[48px] items-center justify-center rounded-xl border border-slate-300 bg-white text-center text-slate-800 shadow-sm transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-slate-900 dark:text-slate-100"
        >
          <DeleteIcon size={20} className="shrink-0" aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!pin || loading}
        className="inline-flex min-h-[48px] w-full items-center justify-center rounded-xl bg-emerald-600 px-4 py-2.5 text-center text-base font-semibold text-white shadow-sm transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 dark:disabled:bg-slate-700 dark:disabled:text-slate-300"
      >
        {loading
          ? t('auth.login.loading')
          : t('common.actions.confirm', { defaultValue: 'Confirm' })}
      </button>
    </LiquidGlassModal>
  )
}

export default PINLoginModal
