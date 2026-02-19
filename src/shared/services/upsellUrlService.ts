/**
 * Upsell URL Service
 *
 * Generates URLs for cross-platform module purchase redirects.
 * Used by POS (Electron) and Mobile apps to redirect to admin dashboard for purchases.
 */

import type {
  BillingCycle,
  PurchaseUrlParams,
  TrialCountdown,
  UpsellSource,
  UpsellContext
} from '../types/upsell';

// ============================================================================
// URL GENERATION
// ============================================================================

/**
 * Generate a URL for module purchase in the admin dashboard
 *
 * @param adminBaseUrl - Base URL of the admin dashboard (e.g., 'https://admin.thesmall.app')
 * @param moduleId - Module ID to purchase
 * @param options - Additional options
 * @returns Full URL for module purchase
 *
 * @example
 * ```typescript
 * const url = generateModulePurchaseUrl(
 *   'https://admin.thesmall.app',
 *   'inventory',
 *   { billingCycle: 'annual', source: 'pos_electron' }
 * );
 * // Returns: https://admin.thesmall.app/profile?tab=modules&purchase=inventory&billing=annual&source=pos_electron
 * ```
 */
export function generateModulePurchaseUrl(
  adminBaseUrl: string,
  moduleId: string,
  options?: {
    billingCycle?: BillingCycle;
    source?: UpsellSource;
    context?: UpsellContext;
    returnUrl?: string;
  }
): string {
  const url = new URL('/profile', adminBaseUrl);

  // Set base parameters
  url.searchParams.set('tab', 'modules');
  url.searchParams.set('purchase', moduleId);

  // Optional parameters
  if (options?.billingCycle) {
    url.searchParams.set('billing', options.billingCycle);
  }
  if (options?.source) {
    url.searchParams.set('source', options.source);
  }
  if (options?.context) {
    url.searchParams.set('context', options.context);
  }
  if (options?.returnUrl) {
    url.searchParams.set('returnUrl', encodeURIComponent(options.returnUrl));
  }

  return url.toString();
}

/**
 * Generate a URL for trial upgrade in the admin dashboard
 *
 * @param adminBaseUrl - Base URL of the admin dashboard
 * @param options - Additional options
 * @returns Full URL for trial upgrade
 */
export function generateTrialUpgradeUrl(
  adminBaseUrl: string,
  options?: {
    source?: UpsellSource;
    context?: UpsellContext;
  }
): string {
  const url = new URL('/profile', adminBaseUrl);

  url.searchParams.set('tab', 'subscription');
  url.searchParams.set('action', 'upgrade');

  if (options?.source) {
    url.searchParams.set('source', options.source);
  }
  if (options?.context) {
    url.searchParams.set('context', options.context);
  }

  return url.toString();
}

/**
 * Generate a URL from PurchaseUrlParams object
 *
 * @param adminBaseUrl - Base URL of the admin dashboard
 * @param params - Purchase URL parameters
 * @returns Full URL for module purchase
 */
export function generatePurchaseUrlFromParams(
  adminBaseUrl: string,
  params: PurchaseUrlParams
): string {
  return generateModulePurchaseUrl(adminBaseUrl, params.moduleId, {
    billingCycle: params.billingCycle,
    source: params.source,
    context: params.context,
    returnUrl: params.returnUrl,
  });
}

// ============================================================================
// TRIAL COUNTDOWN CALCULATIONS
// ============================================================================

/**
 * Calculate trial countdown from trial end date
 *
 * @param trialEndsAt - ISO timestamp when trial ends (or null if no trial)
 * @returns TrialCountdown object with remaining time
 *
 * @example
 * ```typescript
 * const countdown = calculateTrialCountdown('2026-02-01T00:00:00Z');
 * // Returns: { days: 7, hours: 12, minutes: 30, isExpired: false, isUrgent: false, ... }
 * ```
 */
export function calculateTrialCountdown(trialEndsAt: string | null): TrialCountdown {
  if (!trialEndsAt) {
    return {
      days: 0,
      hours: 0,
      minutes: 0,
      isExpired: true,
      isUrgent: false,
      isWarning: false,
      totalMilliseconds: 0,
    };
  }

  const now = new Date();
  const endDate = new Date(trialEndsAt);
  const diffMs = endDate.getTime() - now.getTime();

  if (diffMs <= 0) {
    return {
      days: 0,
      hours: 0,
      minutes: 0,
      isExpired: true,
      isUrgent: false,
      isWarning: false,
      totalMilliseconds: 0,
    };
  }

  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  return {
    days,
    hours,
    minutes,
    isExpired: false,
    isUrgent: days < 3,
    isWarning: days < 7 && days >= 3,
    totalMilliseconds: diffMs,
  };
}

/**
 * Format trial countdown for display
 *
 * @param countdown - TrialCountdown object
 * @returns Formatted string (e.g., "3 days, 5 hours left")
 */
export function formatTrialCountdown(countdown: TrialCountdown): string {
  if (countdown.isExpired) {
    return 'Trial expired';
  }

  const parts: string[] = [];

  if (countdown.days > 0) {
    parts.push(`${countdown.days} day${countdown.days !== 1 ? 's' : ''}`);
  }

  if (countdown.hours > 0 || countdown.days === 0) {
    parts.push(`${countdown.hours} hour${countdown.hours !== 1 ? 's' : ''}`);
  }

  if (countdown.days === 0 && countdown.hours === 0) {
    parts.push(`${countdown.minutes} minute${countdown.minutes !== 1 ? 's' : ''}`);
  }

  return parts.join(', ') + ' left';
}

/**
 * Get urgency color based on trial countdown
 *
 * @param countdown - TrialCountdown object
 * @returns Color name for theming
 */
export function getTrialUrgencyColor(countdown: TrialCountdown): 'success' | 'warning' | 'error' {
  if (countdown.isExpired || countdown.isUrgent) {
    return 'error';
  }
  if (countdown.isWarning) {
    return 'warning';
  }
  return 'success';
}

// ============================================================================
// SAVINGS CALCULATIONS
// ============================================================================

/**
 * Calculate annual savings compared to monthly billing
 *
 * @param monthlyPrice - Monthly price
 * @param annualPrice - Annual price
 * @returns Savings information
 */
export function calculateAnnualSavings(
  monthlyPrice: number,
  annualPrice: number
): {
  savings: number;
  savingsPercentage: number;
  monthlyEquivalent: number;
} {
  const yearlyIfMonthly = monthlyPrice * 12;
  const savings = yearlyIfMonthly - annualPrice;
  const savingsPercentage = yearlyIfMonthly > 0
    ? Math.round((savings / yearlyIfMonthly) * 100)
    : 0;
  const monthlyEquivalent = annualPrice / 12;

  return {
    savings,
    savingsPercentage,
    monthlyEquivalent,
  };
}

/**
 * Format currency for display
 *
 * @param amount - Amount to format
 * @param currency - Currency code (default: 'EUR')
 * @returns Formatted currency string
 */
export function formatUpsellCurrency(
  amount: number,
  currency: string = 'EUR'
): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

// ============================================================================
// ADMIN BASE URL DETECTION
// ============================================================================

/**
 * Get the admin dashboard base URL from environment or config
 *
 * @returns Admin dashboard base URL
 */
export function getAdminBaseUrl(): string {
  // Check for environment variable first
  if (typeof process !== 'undefined' && process.env?.ADMIN_DASHBOARD_URL) {
    return process.env.ADMIN_DASHBOARD_URL;
  }

  // Check for window-based config (Electron)
  if (typeof window !== 'undefined') {
    const windowConfig = (window as any).__ADMIN_CONFIG__;
    if (windowConfig?.baseUrl) {
      return windowConfig.baseUrl;
    }
  }

  // Default to production URL
  return 'https://admin.thesmall.app';
}
