import React, { useState, useEffect } from 'react'
import { LiquidGlassModal } from '../ui/pos-glass-components'
import { useTranslation } from 'react-i18next'

interface PINLoginModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (pin: string) => Promise<boolean> | boolean
  title?: string
  subtitle?: string
}

export const PINLoginModal: React.FC<PINLoginModalProps> = ({ isOpen, onClose, onSubmit, title, subtitle }) => {
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { t } = useTranslation()
  const titleToShow = title ?? t('auth.login.title')
  const subtitleToShow = subtitle ?? t('auth.login.subtitle')

  const handleNumber = (n: string) => {
    if (pin.length < 6) {
      setPin(prev => prev + n)
      setError('')
    }
  }
  const handleBack = () => {
    setPin(prev => prev.slice(0, -1))
    setError('')
  }
  const handleClear = () => {
    setPin('')
    setError('')
  }
  const handleSubmit = async () => {
    if (!pin) {
      setError(t('auth.login.enterPin'))
      return
    }
    setLoading(true)
    try {
      const ok = await onSubmit(pin)
      if (!ok) setError(t('auth.login.error'))
    } finally {
      setLoading(false)
    }
  }

  // Handle keyboard input - attach to document when modal is open
  useEffect(() => {
    if (!isOpen) {
      // Reset state when modal closes
      setPin('')
      setError('')
      setLoading(false)
      return
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      console.log('PINLoginModal keydown:', e.key, 'isOpen:', isOpen, 'loading:', loading)

      // Don't handle if loading
      if (loading) return

      // Don't intercept if user is typing in an input/textarea field
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        console.log('Ignoring keydown - user is typing in', target.tagName)
        return
      }

      // Prevent default for all keys we handle
      if (e.key >= '0' && e.key <= '9') {
        console.log('Number key pressed:', e.key)
        e.preventDefault()
        e.stopPropagation()
        handleNumber(e.key)
      } else if (e.key === 'Backspace') {
        console.log('Backspace pressed')
        e.preventDefault()
        e.stopPropagation()
        handleBack()
      } else if (e.key === 'Delete') {
        console.log('Delete pressed')
        e.preventDefault()
        e.stopPropagation()
        handleClear()
      } else if (e.key === 'Enter') {
        console.log('Enter pressed')
        e.preventDefault()
        e.stopPropagation()
        handleSubmit()
      }
    }

    console.log('Adding keydown listener, isOpen:', isOpen)
    // Add event listener with capture phase to intercept before modal's handlers
    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      console.log('Removing keydown listener')
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isOpen, pin, loading])

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={titleToShow}
      size="md"
    >
          <p className="text-sm text-gray-500 mb-4">{subtitleToShow}</p>

          <div className="bg-gray-100 rounded-xl p-4 text-center mb-3">
            <div className="text-2xl font-mono tracking-widest">
              {pin.replace(/./g, '●') || '──────'}
            </div>
          </div>
          {error && <p className="text-red-600 text-sm mb-3 text-center">{error}</p>}

          <div className="grid grid-cols-3 gap-3 mb-4">
            {[...'123456789'].map(n => (
              <button key={n} onClick={() => handleNumber(n)} className="bg-white hover:bg-gray-50 border rounded-xl py-3 font-semibold">
                {n}
              </button>
            ))}
            <button onClick={handleClear} className="bg-white hover:bg-gray-50 border rounded-xl py-3 font-semibold">
              {t('common.clear')}
            </button>
            <button onClick={() => handleNumber('0')} className="bg-white hover:bg-gray-50 border rounded-xl py-3 font-semibold">
              0
            </button>
            <button onClick={handleBack} className="bg-white hover:bg-gray-50 border rounded-xl py-3 font-semibold">
              ←
            </button>
          </div>

          <button onClick={handleSubmit} disabled={!pin || loading} className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-xl py-3 font-semibold">
            {loading ? t('auth.login.loading') : t('auth.login.submit')}
          </button>
    </LiquidGlassModal>
  )
}

export default PINLoginModal

