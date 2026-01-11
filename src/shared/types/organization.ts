/**
 * Organization Types for POS System
 *
 * Re-exports canonical types from shared for consistency.
 * This ensures POS uses the same BusinessType values as all other apps.
 */

// Re-export BusinessType from shared types (canonical source)
// Note: The shared BusinessType includes all values:
// fast_food, restaurant, hotel, salon, bar_cafe, food_truck,
// chain, franchise, retail, cafe, bar, bakery
export type { BusinessType } from '../../../../shared/types/organization';
