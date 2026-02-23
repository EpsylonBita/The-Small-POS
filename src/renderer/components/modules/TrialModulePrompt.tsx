'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Clock, AlertTriangle, X, ExternalLink } from 'lucide-react'
import { liquidGlassModalCard, liquidGlassModalButton, liquidGlassModalBadge } from '../../styles/designSystem'
import { useTheme } from '../../contexts/theme-context'
import type { TrialCountdown } from '@shared/types/upsell'
import {
  calculateTrialCountdown,
  formatTrialCountdown,
  getTrialUrgencyColor,
  generateTrialUpgradeUrl,
  getAdminBaseUrl,
} from '@shared/services/upsellUrlService'
import { openExternalUrl } from '../../utils/electron-api'

interface TrialModulePromptProps {
  /** Trial end date (ISO timestamp) */
  trialEndsAt: string
  /** Whether the prompt can be dismissed */
  dismissible?: boolean
  /** Position on screen */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
  /** Callback when prompt is dismissed */
  onDismiss?: () => void
  /** Callback when contact admin is clicked */
  onContactAdmin?: () => void
}

const STORAGE_KEY = 'pos-trial-prompt-dismissed'
const AUTO_SHOW_THRESHOLD_DAYS = 7

/**
 * TrialModulePrompt - Floating notification for trial expiration
 *
 * Features:
 * - Toast-style position (configurable corner)
 * - Countdown timer display
 * - "Contact Administrator" action
 * - Dismissible with localStorage persistence
 * - Auto-shows when trial < 7 days
 */
export const TrialModulePrompt: React.FC<TrialModulePromptProps> = ({
  trialEndsAt,
  dismissible = true,
  position = 'bottom-right',
  onDismiss,
  onContactAdmin,
}) => {
  const { resolvedTheme } = useTheme()
  const [countdown, setCountdown] = useState<TrialCountdown | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const [isDismissed, setIsDismissed] = useState(false)

  // Check dismissal and calculate countdown
  useEffect(() => {
    // Check localStorage for dismissal
    const dismissedData = localStorage.getItem(STORAGE_KEY)
    if (dismissedData) {
      try {
        const { timestamp, trialEndsAt: storedTrialEnds } = JSON.parse(dismissedData)
        // Reset dismissal if trial end date changed or 24 hours passed
        const now = Date.now()
        const dismissedTime = new Date(timestamp).getTime()
        if (storedTrialEnds === trialEndsAt && now - dismissedTime < 24 * 60 * 60 * 1000) {
          setIsDismissed(true)
          return
        } else {
          localStorage.removeItem(STORAGE_KEY)
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY)
      }
    }

    // Calculate countdown
    const newCountdown = calculateTrialCountdown(trialEndsAt)
    setCountdown(newCountdown)

    // Auto-show if within threshold and not expired
    if (!newCountdown.isExpired && newCountdown.days < AUTO_SHOW_THRESHOLD_DAYS) {
      setIsVisible(true)
    }
  }, [trialEndsAt])

  // Update countdown on minute boundaries without interval polling
  useEffect(() => {
    if (!trialEndsAt || isDismissed) return

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const scheduleNextMinuteUpdate = () => {
      const msUntilNextMinute = Math.max(250, 60000 - (Date.now() % 60000))
      timeoutId = setTimeout(() => {
        if (cancelled) return
        const nextCountdown = calculateTrialCountdown(trialEndsAt)
        setCountdown(nextCountdown)
        if (!nextCountdown.isExpired) {
          scheduleNextMinuteUpdate()
        }
      }, msUntilNextMinute)
    }

    setCountdown(calculateTrialCountdown(trialEndsAt))
    scheduleNextMinuteUpdate()

    return () => {
      cancelled = true
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [trialEndsAt, isDismissed])

  // Handle dismiss
  const handleDismiss = useCallback(() => {
    setIsDismissed(true)
    setIsVisible(false)
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        trialEndsAt,
      })
    )
    onDismiss?.()
  }, [trialEndsAt, onDismiss])

  // Handle contact admin
  const handleContactAdmin = useCallback(() => {
    if (onContactAdmin) {
      onContactAdmin()
      return
    }

    // Default: Open admin dashboard
    const adminUrl = getAdminBaseUrl()
    const upgradeUrl = generateTrialUpgradeUrl(adminUrl, {
      source: 'pos_tauri',
      context: 'trial_countdown',
    })

    void openExternalUrl(upgradeUrl)

    // Track analytics
    fetch('/api/analytics/upsell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'trial_action',
        module_id: 'trial',
        source: 'pos_tauri',
        context: 'trial_countdown',
        timestamp: new Date().toISOString(),
        metadata: { action: 'contact_admin' },
      }),
    }).catch(() => {/* Ignore analytics errors */})
  }, [onContactAdmin])

  // Don't render if not visible, dismissed, or no countdown
  if (!isVisible || isDismissed || !countdown || countdown.isExpired) {
    return null
  }

  const urgencyColor = getTrialUrgencyColor(countdown)
  const isUrgent = countdown.isUrgent

  // Position classes
  const positionClasses = {
    'bottom-right': 'bottom-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'top-right': 'top-4 right-4',
    'top-left': 'top-4 left-4',
  }

  // Color classes based on urgency
  const colorClasses = {
    success: {
      border: 'border-green-500/30',
      icon: 'text-green-400',
      bg: 'from-green-500/10 to-transparent',
    },
    warning: {
      border: 'border-amber-500/30',
      icon: 'text-amber-400',
      bg: 'from-amber-500/10 to-transparent',
    },
    error: {
      border: 'border-red-500/30',
      icon: 'text-red-400',
      bg: 'from-red-500/10 to-transparent',
    },
  }

  const colors = colorClasses[urgencyColor]

  return (
    <div
      className={`fixed ${positionClasses[position]} z-50 animate-in slide-in-from-bottom-4 fade-in duration-300`}
      style={{ maxWidth: 360 }}
    >
      <div
        className={`${liquidGlassModalCard()} ${colors.border} border bg-gradient-to-r ${colors.bg}`}
        style={{ backdropFilter: 'blur(20px)' }}
      >
        {/* Header with dismiss button */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            {isUrgent ? (
              <AlertTriangle className={`h-5 w-5 ${colors.icon}`} />
            ) : (
              <Clock className={`h-5 w-5 ${colors.icon}`} />
            )}
            <span className="font-semibold text-white">
              {isUrgent ? 'Trial Ending Soon!' : 'Trial Period'}
            </span>
          </div>
          {dismissible && (
            <button
              onClick={handleDismiss}
              className="p-1 hover:bg-white/10 rounded-lg transition-colors"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4 text-gray-400" />
            </button>
          )}
        </div>

        {/* Countdown */}
        <div className="mb-4">
          <p className="text-2xl font-bold text-white">
            {countdown.days}d {countdown.hours}h {countdown.minutes}m
          </p>
          <p className="text-sm text-gray-400">
            {formatTrialCountdown(countdown)}
          </p>
        </div>

        {/* Message */}
        <p className="text-sm text-gray-300 mb-4">
          {isUrgent
            ? 'Contact your administrator to upgrade and keep access to all modules.'
            : 'All modules are available during your trial period.'}
        </p>

        {/* Action button */}
        <button
          className={`${liquidGlassModalButton(isUrgent ? 'primary' : 'secondary', 'md')} w-full flex items-center justify-center gap-2`}
          onClick={handleContactAdmin}
          style={{ minHeight: 44 }}
        >
          Contact Administrator
          <ExternalLink className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export default TrialModulePrompt

