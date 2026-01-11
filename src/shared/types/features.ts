/**
 * Feature Types for POS System
 *
 * Re-exports canonical FeatureFlag type from shared for type safety.
 * POS-specific feature configurations are kept locally.
 */

// Re-export canonical FeatureFlag type from shared
export type { FeatureFlag } from '../../../../shared/types/features';

// Re-export plan mapping constants from shared
export {
  FEATURE_PLAN_MAP,
  getRequiredPlanForFeature,
  ALL_FEATURES,
  STARTER_FEATURES as SHARED_STARTER_FEATURES,
  PROFESSIONAL_FEATURES,
  ENTERPRISE_FEATURES,
} from '../../../../shared/types/features';

/**
 * POS-specific features available on Starter plan
 * This is a simplified list for POS navigation/UI purposes
 */
export const STARTER_FEATURES: string[] = [
  'pos',
  'orders',
  'menu',
  'customers',
  'dashboard',
  'settings',
];
