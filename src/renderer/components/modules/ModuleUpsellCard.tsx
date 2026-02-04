'use client'

import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Lock, Sparkles, Check, ExternalLink, X, ChevronRight, Loader2, Package } from 'lucide-react'
import { LiquidGlassModal, POSGlassButton } from '../ui/pos-glass-components'
import { liquidGlassModalButton, liquidGlassModalCard, liquidGlassModalBadge } from '../../styles/designSystem'
import { useTheme } from '../../contexts/theme-context'
import type { ModuleUpsellInfo, UpsellCardVariant } from '@shared/types/upsell'
import {
  generateModulePurchaseUrl,
  getAdminBaseUrl,
  formatUpsellCurrency,
  calculateAnnualSavings,
} from '@shared/services/upsellUrlService'

interface ModuleUpsellCardProps {
  /** Module ID to display */
  moduleId: string
  /** Display variant */
  variant?: UpsellCardVariant
  /** Whether modal is open (for modal variant) */
  isOpen?: boolean
  /** Callback to close modal */
  onClose?: () => void
  /** Callback for learn more action */
  onLearnMore?: () => void
  /** Module info if already loaded */
  moduleInfo?: ModuleUpsellInfo
}

/**
 * ModuleUpsellCard - POS-optimized upsell component using LiquidGlass design
 *
 * Features:
 * - Lock icon with gradient circle
 * - Module name, description, benefits list
 * - "Upgrade Now" redirects to admin dashboard
 * - "Learn More" shows feature details
 * - Touch-optimized (44px+ touch targets)
 *
 * Variants:
 * - compact: Small inline card
 * - expanded: Full card with features
 * - modal: Full modal experience
 */
export const ModuleUpsellCard: React.FC<ModuleUpsellCardProps> = ({
  moduleId,
  variant = 'compact',
  isOpen = false,
  onClose,
  onLearnMore,
  moduleInfo: externalModuleInfo,
}) => {
  const { resolvedTheme } = useTheme()
  const [moduleInfo, setModuleInfo] = useState<ModuleUpsellInfo | null>(externalModuleInfo || null)
  const [isLoading, setIsLoading] = useState(!externalModuleInfo)
  const [isModalOpen, setIsModalOpen] = useState(false)

  // Fetch module info if not provided
  useEffect(() => {
    if (externalModuleInfo) {
      setModuleInfo(externalModuleInfo)
      setIsLoading(false)
      return
    }

    // Fetch from API
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

  // Calculate savings
  const pricing = useMemo(() => {
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

  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)

  // Handle upgrade click - creates Stripe Checkout session and opens in browser
  const handleUpgrade = useCallback(async () => {
    setIsCheckoutLoading(true)

    try {
      // Track analytics first
      fetch('/api/analytics/upsell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'click',
          module_id: moduleId,
          source: 'pos_electron',
          context: 'locked_module',
          timestamp: new Date().toISOString(),
        }),
      }).catch(() => {/* Ignore analytics errors */})

      // Create Stripe Checkout session via API
      const response = await fetch('/api/modules/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module_id: moduleId,
          billing_cycle: 'monthly',
          source: 'pos_electron',
          context: 'locked_module',
        }),
      })

      const data = await response.json()

      if (!response.ok || !data.checkout_url) {
        throw new Error(data.error || 'Failed to create checkout session')
      }

      // Open Stripe Checkout in external browser
      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(data.checkout_url)
      } else {
        window.open(data.checkout_url, '_blank')
      }
    } catch (err) {
      console.error('Failed to create checkout:', err)
      // Fallback to admin dashboard redirect
      const adminUrl = getAdminBaseUrl()
      const purchaseUrl = generateModulePurchaseUrl(adminUrl, moduleId, {
        source: 'pos_electron',
        context: 'locked_module',
      })

      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(purchaseUrl)
      } else {
        window.open(purchaseUrl, '_blank')
      }
    } finally {
      setIsCheckoutLoading(false)
    }
  }, [moduleId])

  // Handle modal close
  const handleClose = useCallback(() => {
    setIsModalOpen(false)
    onClose?.()
  }, [onClose])

  // Handle learn more
  const handleLearnMore = useCallback(() => {
    if (variant === 'compact') {
      setIsModalOpen(true)
    }
    onLearnMore?.()
  }, [variant, onLearnMore])

  // Loading state
  if (isLoading) {
    return (
      <div className={liquidGlassModalCard()}>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-blue-400" />
        </div>
      </div>
    )
  }

  // No module info
  if (!moduleInfo) {
    return null
  }

  // Compact variant - inline card
  if (variant === 'compact') {
    return (
      <>
        <div className={`${liquidGlassModalCard()} cursor-pointer hover:bg-white/5 transition-colors`} onClick={handleLearnMore}>
          <div className="flex items-center gap-3">
            {/* Lock icon with gradient */}
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500/30 to-purple-500/30 flex items-center justify-center flex-shrink-0">
              <Lock className="h-5 w-5 text-blue-400" />
            </div>

            <div className="flex-1 min-w-0">
              <h4 className="font-medium text-white truncate">{moduleInfo.display_name}</h4>
              <p className="text-sm text-gray-400 truncate">{moduleInfo.description}</p>
            </div>

            <ChevronRight className="h-5 w-5 text-gray-500 flex-shrink-0" />
          </div>
        </div>

        {/* Expanded modal */}
        <LiquidGlassModal
          isOpen={isModalOpen}
          onClose={handleClose}
          title={moduleInfo.display_name}
          size="md"
        >
          <ModuleUpsellContent
            moduleInfo={moduleInfo}
            pricing={pricing}
            onUpgrade={handleUpgrade}
            onClose={handleClose}
            isLoading={isCheckoutLoading}
          />
        </LiquidGlassModal>
      </>
    )
  }

  // Expanded variant - full card
  if (variant === 'expanded') {
    return (
      <div className={liquidGlassModalCard()}>
        <ModuleUpsellContent
          moduleInfo={moduleInfo}
          pricing={pricing}
          onUpgrade={handleUpgrade}
          onClose={handleClose}
          compact
          isLoading={isCheckoutLoading}
        />
      </div>
    )
  }

  // Modal variant
  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleClose}
      title={moduleInfo.display_name}
      size="md"
    >
      <ModuleUpsellContent
        moduleInfo={moduleInfo}
        pricing={pricing}
        onUpgrade={handleUpgrade}
        onClose={handleClose}
        isLoading={isCheckoutLoading}
      />
    </LiquidGlassModal>
  )
}

// Internal content component
interface ModuleUpsellContentProps {
  moduleInfo: ModuleUpsellInfo
  pricing: {
    monthly: number
    annual: number
    currency: string
    annualSavings: number
    savingsPercentage: number
    monthlyEquivalent: number
  } | null
  onUpgrade: () => void
  onClose?: () => void
  compact?: boolean
  isLoading?: boolean
}

const ModuleUpsellContent: React.FC<ModuleUpsellContentProps> = ({
  moduleInfo,
  pricing,
  onUpgrade,
  onClose,
  compact = false,
  isLoading = false,
}) => {
  return (
    <div className="space-y-6">
      {/* Header with icon and description */}
      <div className="flex items-start gap-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500/30 to-purple-500/30 flex items-center justify-center flex-shrink-0">
          <Lock className="h-8 w-8 text-blue-400" />
        </div>
        <div>
          {compact && (
            <h4 className="font-semibold text-white mb-1">{moduleInfo.display_name}</h4>
          )}
          <p className="text-gray-300">{moduleInfo.description}</p>
        </div>
      </div>

      {/* Features list */}
      <div>
        <h5 className="font-medium text-white mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-400" />
          Included Features
        </h5>
        <ul className="space-y-2">
          {moduleInfo.features.slice(0, compact ? 3 : 5).map((feature) => (
            <li key={feature.id} className="flex items-start gap-2">
              <Check className="h-4 w-4 text-green-400 mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-sm text-white">{feature.name}</span>
                {!compact && feature.description && (
                  <p className="text-xs text-gray-400">{feature.description}</p>
                )}
              </div>
            </li>
          ))}
          {moduleInfo.features.length > (compact ? 3 : 5) && (
            <li className="text-sm text-gray-400 pl-6">
              +{moduleInfo.features.length - (compact ? 3 : 5)} more features
            </li>
          )}
        </ul>
      </div>

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
                Save {pricing.savingsPercentage}% annually
              </span>
            )}
          </div>
        </div>
      )}

      {/* Checkout notice */}
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <ExternalLink className="h-4 w-4" />
        <span>Opens secure checkout in your browser</span>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        {onClose && (
          <button
            className={liquidGlassModalButton('secondary', 'lg')}
            onClick={onClose}
            style={{ minHeight: 48 }}
            disabled={isLoading}
          >
            Cancel
          </button>
        )}
        <button
          className={`${liquidGlassModalButton('primary', 'lg')} flex-1`}
          onClick={onUpgrade}
          style={{ minHeight: 48 }}
          disabled={isLoading}
        >
          <span className="flex items-center justify-center gap-2">
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                Upgrade Now
                <ExternalLink className="h-4 w-4" />
              </>
            )}
          </span>
        </button>
      </div>
    </div>
  )
}

export default ModuleUpsellCard
