/**
 * Organization Types (POS-local stub)
 */

export type BusinessType = 
  | 'restaurant'
  | 'cafe'
  | 'bar'
  | 'fast_food'
  | 'hotel'
  | 'retail'
  | 'salon'
  | 'bar_cafe'
  | 'food_truck'
  | 'chain'
  | 'franchise'
  | 'other'
  | string; // Allow any string for flexibility

export interface Organization {
  id: string;
  name: string;
  businessType: BusinessType;
  createdAt?: string;
}
