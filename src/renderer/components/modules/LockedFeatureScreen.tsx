'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Lock, ExternalLink, ArrowLeft, Loader2, Package, Sparkles, Check } from 'lucide-react'
import { LiquidGlassModal, POSGlassButton, POSGlassCard } from '../ui/pos-glass-components'
import { liquidGlassModalButton, liquidGlassModalCard, liquidGlassModalBadge } from '../../styles/designSystem'
import { useTheme } from '../../contexts/theme-context'
import type { ModuleUpsellInfo } from '@shared/types/upsell'
import {
  generateModulePurchaseUrl,
  getAdminBaseUrl,
  formatUpsellCurrency,
  calculateAnnualSavings,
} from '@shared/services/upsellUrlService'
import { openExternalUrl } from '../../utils/electron-api'

interface LockedFeatureScreenProps {
  /** Module ID that's locked */
  moduleId: string
  /** Custom feature name for display */
  featureName?: string
  /** Callback when contact admin is clicked */
  onContactAdmin?: () => void
  /** Callback when back is clicked */
  onBack?: () => void
  /** Module info if already loaded */
  moduleInfo?: ModuleUpsellInfo
  /** Custom back button label */
  backLabel?: string
}

/**
 * LockedFeatureScreen - Full-page locked feature screen for POS Electron
 *
 * Features:
 * - Large lock icon with LiquidGlass styling
 * - Module name, description, and benefits
 * - "Contact Admin to Upgrade" button (opens admin dashboard)
 * - "Go Back" secondary action
 * - Touch-optimized (44px+ touch targets)
 */
export const LockedFeatureScreen: React.FC<LockedFeatureScreenProps> = ({
  moduleId,
  featureName,
  onContactAdmin,
  onBack,
  moduleInfo: externalModuleInfo,
  backLabel = 'Go Back',
}) => {
  const { resolvedTheme } = useTheme()
  const [moduleInfo, setModuleInfo] = useState<ModuleUpsellInfo | null>(externalModuleInfo || null)
  const [isLoading, setIsLoading] = useState(!externalModuleInfo)
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)
  const [showLearnMore, setShowLearnMore] = useState(false)

  // Fetch module info if not provided
  useEffect(() => {
    if (externalModuleInfo) {
      setModuleInfo(externalModuleInfo)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    fetch(`/api/modules/upsell?module_id=${encodeURIComponent(moduleId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.module) {
          setModuleInfo(data.module)
        }
      })
      .catch((err) => {
        console.error('Failed to fetch module info:', err)
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [moduleId, externalModuleInfo])

  // Track view event
  useEffect(() => {
    fetch('/api/analytics/upsell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'view',
        module_id: moduleId,
        source: 'pos_tauri',
        context: 'feature_gate',
        timestamp: new Date().toISOString(),
        metadata: { screen: 'locked_feature' },
      }),
    }).catch(() => {/* Ignore analytics errors */})
  }, [moduleId])

  // Calculate pricing
  const pricing = React.useMemo(() => {
    if (!moduleInfo) return null
    const { savings, savingsPercentage, monthlyEquivalent } = calculateAnnualSavings(
      moduleInfo.pricing.monthly,
      moduleInfo.pricing.annual
    )
    return {
      ...moduleInfo.pricing,
      annualSavings: savings,
      savingsPercentage,
      monthlyEquivalent,
    }
  }, [moduleInfo])

  // Handle upgrade - open admin dashboard in browser
  const handleUpgrade = useCallback(async () => {
    setIsCheckoutLoading(true)

    try {
      // Track analytics
      fetch('/api/analytics/upsell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'click',
          module_id: moduleId,
          source: 'pos_tauri',
          context: 'feature_gate',
          timestamp: new Date().toISOString(),
          metadata: { action: 'upgrade' },
        }),
      }).catch(() => {/* Ignore */})

      // Try to create checkout session
      const response = await fetch('/api/modules/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module_id: moduleId,
          billing_cycle: 'monthly',
          source: 'pos_tauri',
          context: 'feature_gate',
        }),
      })

      const data = await response.json()

      if (response.ok && data.checkout_url) {
        // Open checkout in external browser
        await openExternalUrl(data.checkout_url)
      } else {
        throw new Error(data.error || 'Failed to create checkout')
      }
    } catch (err) {
      // Fallback to admin dashboard
      const adminUrl = getAdminBaseUrl()
      const purchaseUrl = generateModulePurchaseUrl(adminUrl, moduleId, {
        source: 'pos_tauri',
        context: 'feature_gate',
      })

      await openExternalUrl(purchaseUrl)
    } finally {
      setIsCheckoutLoading(false)
    }

    onContactAdmin?.()
  }, [moduleId, onContactAdmin])

  // Handle back
  const handleBack = useCallback(() => {
    // Track analytics
    fetch('/api/analytics/upsell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'dismiss',
        module_id: moduleId,
        source: 'pos_tauri',
        context: 'feature_gate',
        timestamp: new Date().toISOString(),
        metadata: { action: 'back' },
      }),
    }).catch(() => {/* Ignore */})

    onBack?.()
  }, [moduleId, onBack])

  // Display name
  const displayName = featureName || moduleInfo?.display_name ||
    moduleId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  return (
    <div className="flex items-center justify-center min-h-[80vh] p-6">
      <div className="w-full max-w-lg">
        {/* Main card */}
        <POSGlassCard className="p-8 text-center">
          {/* Lock icon with gradient */}
          <div className="mx-auto w-24 h-24 rounded-full bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center mb-6 relative">
            <div className="absolute inset-0 rounded-full bg-gradient-to-br from-blue-500/10 to-purple-500/10 blur-xl" />
            <Lock className="h-12 w-12 text-blue-400 relative z-10" />
          </div>

          {/* Title */}
          <h2 className="text-2xl font-bold text-white mb-2">
            {displayName} is Locked
          </h2>

          {/* Description */}
          <p className="text-gray-400 mb-6 max-w-md mx-auto">
            {moduleInfo?.description || `This feature requires the ${displayName} module. Contact your administrator to upgrade and unlock full functionality.`}
          </p>

          {/* Loading state */}
          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-6 w-6 animate-spin text-blue-400" />
            </div>
          ) : (
            <>
              {/* Pricing badge */}
              {pricing && pricing.monthly > 0 && (
                <div className={`${liquidGlassModalCard()} inline-flex items-center gap-2 mb-6`}>
                  <span className="text-gray-400">Starting at</span>
                  <span className="text-xl font-bold text-white">
                    {formatUpsellCurrency(pricing.monthly, pricing.currency)}
                    <span className="text-sm font-normal text-gray-400">/mo</span>
                  </span>
                  {pricing.savingsPercentage > 0 && (
                    <span className={liquidGlassModalBadge('success')}>
                      Save {pricing.savingsPercentage}% yearly
                    </span>
                  )}
                </div>
              )}

              {/* Benefits preview */}
              {moduleInfo && moduleInfo.features.length > 0 && (
                <button
                  className="text-sm text-blue-400 hover:text-blue-300 transition-colors mb-6 flex items-center gap-1 mx-auto"
                  onClick={() => setShowLearnMore(true)}
                >
                  <Sparkles className="h-4 w-4" />
                  See what's included
                </button>
              )}

              {/* Action buttons */}
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  className={`${liquidGlassModalButton('secondary', 'lg')} flex items-center justify-center gap-2`}
                  onClick={handleBack}
                  style={{ minHeight: 48, minWidth: 120 }}
                  disabled={isCheckoutLoading}
                >
                  <ArrowLeft className="h-4 w-4" />
                  {backLabel}
                </button>
                <button
                  className={`${liquidGlassModalButton('primary', 'lg')} flex items-center justify-center gap-2`}
                  onClick={handleUpgrade}
                  style={{ minHeight: 48, minWidth: 180 }}
                  disabled={isCheckoutLoading}
                >
                  {isCheckoutLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="h-4 w-4" />
                      Unlock Module
                    </>
                  )}
                </button>
              </div>

              {/* Notice */}
              <p className="text-xs text-gray-500 mt-4 flex items-center justify-center gap-1">
                <ExternalLink className="h-3 w-3" />
                Opens secure checkout in your browser
              </p>
            </>
          )}
        </POSGlassCard>

        {/* Learn more modal */}
        {moduleInfo && (
          <LiquidGlassModal
            isOpen={showLearnMore}
            onClose={() => setShowLearnMore(false)}
            title={`${moduleInfo.display_name} Features`}
            size="md"
            className="!max-w-lg"
          >
            <div className="space-y-6">
              {/* Description */}
              <p className="text-gray-300">{moduleInfo.description}</p>

              {/* Features list */}
              <div>
                <h5 className="font-medium text-white mb-3 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-400" />
                  What's Included
                </h5>
                <ul className="space-y-2">
                  {moduleInfo.features.map((feature) => (
                    <li key={feature.id} className="flex items-start gap-2">
                      <Check className="h-4 w-4 text-green-400 mt-0.5 flex-shrink-0" />
                      <div>
                        <span className="text-sm text-white">{feature.name}</span>
                        {feature.description && (
                          <p className="text-xs text-gray-400">{feature.description}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Unlocked features */}
              {moduleInfo.unlocked_features && moduleInfo.unlocked_features.length > 0 && (
                <div className={liquidGlassModalCard()}>
                  <p className="text-sm text-gray-400">
                    Unlocking this module also enables:{' '}
                    <span className="text-white">{moduleInfo.unlocked_features.join(', ')}</span>
                  </p>
                </div>
              )}

              {/* Pricing */}
              {pricing && (
                <div className={liquidGlassModalCard()}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-400">Starting at</p>
                      <p className="text-2xl font-bold text-white">
                        {formatUpsellCurrency(pricing.monthly, pricing.currency)}
                        <span className="text-sm font-normal text-gray-400">/mo</span>
                      </p>
                    </div>
                    {pricing.savingsPercentage > 0 && (
                      <span className={liquidGlassModalBadge('success')}>
                        Save {pricing.savingsPercentage}% yearly
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  className={liquidGlassModalButton('secondary', 'lg')}
                  onClick={() => setShowLearnMore(false)}
                  style={{ minHeight: 48 }}
                >
                  Close
                </button>
                <button
                  className={`${liquidGlassModalButton('primary', 'lg')} flex-1`}
                  onClick={() => {
                    setShowLearnMore(false)
                    handleUpgrade()
                  }}
                  style={{ minHeight: 48 }}
                  disabled={isCheckoutLoading}
                >
                  <span className="flex items-center justify-center gap-2">
                    {isCheckoutLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      <>
                        Unlock Now
                        <ExternalLink className="h-4 w-4" />
                      </>
                    )}
                  </span>
                </button>
              </div>
            </div>
          </LiquidGlassModal>
        )}
      </div>
    </div>
  )
}

export default LockedFeatureScreen

