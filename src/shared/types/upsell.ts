/**
 * Upsell Types
 *
 * Core type definitions for module upsell components across all platforms:
 * - Admin Dashboard (Next.js)
 * - POS System (Electron)
 * - Mobile App (React Native)
 */

import type { BusinessCategory, ModuleId } from './modules';
import type { BillingCycle } from './organization';

// Re-export BillingCycle for convenience
export type { BillingCycle };

// ============================================================================
// MODULE FEATURE TYPES
// ============================================================================

/**
 * A feature provided by a module
 */
export interface ModuleFeature {
  /** Unique feature identifier */
  id: string;
  /** Feature name */
  name: string;
  /** Feature description */
  description: string;
  /** Optional icon name from lucide-react */
  icon?: string;
}

/**
 * Module upsell information for purchase prompts
 */
export interface ModuleUpsellInfo {
  /** Module identifier */
  module_id: ModuleId | string;
  /** Internal module name */
  name: string;
  /** Display name for UI */
  display_name: string;
  /** Module description */
  description: string;
  /** Icon name from lucide-react */
  icon: string;
  /** Pricing information */
  pricing: {
    monthly: number;
    annual: number;
    currency: string;
  };
  /** List of features included with this module */
  features: ModuleFeature[];
  /** Required module dependencies */
  dependencies: string[];
  /** Features unlocked when this module is purchased */
  unlocked_features: string[];
  /** Business category this module belongs to */
  category: BusinessCategory | 'shared';
  /** Whether this module is available for trial */
  trial_available?: boolean;
  /** Trial duration in days */
  trial_days?: number;
}

// ============================================================================
// TRIAL COUNTDOWN TYPES
// ============================================================================

/**
 * Trial countdown information for display
 */
export interface TrialCountdown {
  /** Days remaining in trial */
  days: number;
  /** Hours remaining (0-23) */
  hours: number;
  /** Minutes remaining (0-59) */
  minutes: number;
  /** Whether the trial has expired */
  isExpired: boolean;
  /** Whether trial is urgent (< 3 days remaining) */
  isUrgent: boolean;
  /** Whether trial is warning (< 7 days remaining) */
  isWarning: boolean;
  /** Total milliseconds remaining */
  totalMilliseconds: number;
}

/**
 * Trial status for an organization
 */
export interface TrialStatus {
  /** Whether organization is in trial period */
  is_trialing: boolean;
  /** When the trial ends (ISO timestamp) */
  trial_ends_at: string | null;
  /** Days remaining in trial */
  days_remaining: number;
  /** Whether payment method has been added */
  payment_method_added: boolean;
}

// ============================================================================
// ANALYTICS TYPES
// ============================================================================

/**
 * Type of upsell analytics event
 */
export type UpsellEventType =
  | 'view'              // Component was viewed
  | 'click'             // User clicked a CTA
  | 'purchase'          // Purchase was completed
  | 'dismiss'           // User dismissed the prompt
  | 'trial_view'        // Trial countdown was viewed
  | 'trial_action'      // User acted on trial prompt
  // New Phase 4 event types for detailed purchase flow tracking
  | 'purchase_intent'   // User initiated purchase (clicked buy)
  | 'purchase_completed'// Payment succeeded
  | 'purchase_failed'   // Payment failed
  | 'bundle_suggested'  // Bundle was shown to user
  | 'bundle_purchased'  // Bundle was purchased
  | 'dependency_warning'// Dependency warning was shown
  | 'trial_expiry_view' // Trial expiry banner was viewed
  | 'trial_expiry_action'; // User acted on trial expiry

/**
 * Source platform for upsell events
 */
export type UpsellSource =
  | 'admin_dashboard'
  | 'pos_tauri'
  | 'pos_mobile';

/**
 * Context where upsell was triggered
 */
export type UpsellContext =
  | 'locked_module'       // User clicked a locked module
  | 'feature_gate'        // User tried to use a gated feature
  | 'trial_countdown'     // Trial countdown timer
  | 'comparison_table'    // Feature comparison table
  | 'navigation'          // Navigation sidebar
  | 'onboarding'          // Onboarding flow
  | 'banner';             // Promotional banner

/**
 * Analytics event for upsell tracking
 */
export interface UpsellAnalyticsEvent {
  /** Type of event */
  event_type: UpsellEventType;
  /** Module involved in the event */
  module_id: string;
  /** Source platform */
  source: UpsellSource;
  /** Context where event occurred */
  context: UpsellContext;
  /** Event timestamp (ISO string) */
  timestamp: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Aggregated upsell metrics
 */
export interface UpsellMetrics {
  /** Total views */
  views: number;
  /** Total clicks */
  clicks: number;
  /** Total purchases */
  purchases: number;
  /** Conversion rate (purchases/views) */
  conversion_rate: number;
  /** Total revenue generated */
  revenue: number;
  /** Breakdown by source */
  by_source: Record<UpsellSource, number>;
  /** Breakdown by context */
  by_context: Record<UpsellContext, number>;
  /** Time period for these metrics */
  period: '7d' | '30d' | '90d';
}

// ============================================================================
// PURCHASE FLOW TYPES
// ============================================================================

/**
 * Purchase request from upsell component
 */
export interface UpsellPurchaseRequest {
  /** Module to purchase */
  module_id: string;
  /** Billing cycle selection */
  billing_cycle: BillingCycle;
  /** Source platform */
  source: UpsellSource;
  /** Context where purchase was initiated */
  context: UpsellContext;
}

/**
 * Purchase URL parameters for cross-platform redirects
 */
export interface PurchaseUrlParams {
  /** Module ID to pre-select */
  moduleId: string;
  /** Billing cycle preference */
  billingCycle?: BillingCycle;
  /** Source for analytics */
  source: UpsellSource;
  /** Context for analytics */
  context: UpsellContext;
  /** Return URL after purchase */
  returnUrl?: string;
}

// ============================================================================
// COMPONENT PROPS TYPES
// ============================================================================

/**
 * Common props for upsell components across platforms
 */
export interface BaseUpsellProps {
  /** Module to promote */
  moduleId: string;
  /** Whether to show trial option */
  showTrialOption?: boolean;
  /** Callback when purchase/trial is initiated */
  onAction?: (action: 'purchase' | 'trial' | 'learn_more') => void;
  /** Callback when component is dismissed */
  onDismiss?: () => void;
}

/**
 * Variant options for upsell cards
 */
export type UpsellCardVariant = 'compact' | 'expanded' | 'modal' | 'full';

/**
 * Trial countdown badge variants
 */
export type TrialCountdownVariant = 'badge' | 'banner' | 'inline' | 'card';

// ============================================================================
// FEATURE COMPARISON TYPES
// ============================================================================

/**
 * Feature comparison item
 */
export interface FeatureComparisonItem {
  /** Feature identifier */
  id: string;
  /** Feature name */
  name: string;
  /** Feature description */
  description?: string;
  /** Availability per module (module_id -> boolean) */
  availability: Record<string, boolean>;
  /** Whether this is a highlight feature for the target module */
  isHighlight?: boolean;
}

/**
 * Feature comparison table data
 */
export interface FeatureComparisonData {
  /** Modules being compared */
  modules: Array<{
    id: string;
    name: string;
    display_name: string;
    icon: string;
    price_monthly: number;
    is_current: boolean;
  }>;
  /** Features to compare */
  features: FeatureComparisonItem[];
  /** Recommended bundle (if applicable) */
  recommended_bundle?: {
    id: string;
    name: string;
    display_name: string;
    price_monthly: number;
    savings_percentage: number;
  };
}

