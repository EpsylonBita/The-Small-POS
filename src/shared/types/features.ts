/**
 * Feature Types for POS System
 * 
 * Stub definitions for feature flags and plan mapping.
 */

export type FeatureFlag = string;

/**
 * Map of features to required plans
 */
export const FEATURE_PLAN_MAP: Record<string, string> = {
  // Core features available on all plans
  'pos': 'Starter',
  'orders': 'Starter',
  'menu': 'Starter',
  // Professional features
  'analytics': 'Professional',
  'inventory': 'Professional',
  'staff': 'Professional',
  // Enterprise features
  'multi-branch': 'Enterprise',
  'api-access': 'Enterprise',
};

/**
 * Features available on Starter plan
 */
export const STARTER_FEATURES: string[] = [
  'pos',
  'orders',
  'menu',
  'customers',
  'dashboard',
  'settings',
];
