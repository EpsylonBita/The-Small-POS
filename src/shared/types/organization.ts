/**
 * Organization Types for POS System
 *
 * Re-exports canonical types from shared for consistency.
 * This ensures POS uses the same BusinessType values as all other apps.
 */

// Re-export BusinessType from shared types (canonical source)
// See shared/types/organization.ts for all supported values including:
// Food Service: fast_food, restaurant, cafe, bar, bar_cafe, bakery, catering, ghost_kitchen
// Hospitality: hotel, hotel_restaurant
// Service: salon, spa, barbershop, beauty_salon, wellness, fitness, clinic, dental, medical_clinic, veterinary, physiotherapy
// Retail: retail, shop, boutique, convenience, grocery
// Business Models: food_truck, chain, franchise
export type { BusinessType } from '../../../../shared/types/organization';
