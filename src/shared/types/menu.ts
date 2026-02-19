/**
 * Menu Type Definitions
 * Shared types for menu items across all applications
 * 
 * These types are designed to work with the multi-price menu system
 * supporting Delivery/Pickup/In-store pricing based on acquired modules.
 */

/**
 * MenuItem interface representing a menu item with multi-price support
 * 
 * Price fields:
 * - price: Primary price field (NOT NULL in DB)
 * - pickupPrice: Price for pickup orders (fallback to price if null)
 * - deliveryPrice: Price for delivery orders (only available when Delivery module acquired)
 * - instorePrice: Price for in-store/table orders (only available when Tables module acquired)
 * 
 * Price fallback logic: If a specific price type is null/undefined, use pickupPrice or price as fallback
 */
export interface MenuItem {
  id: string;
  categoryId: string;
  organizationId?: string | null;

  // Name fields
  name?: string;
  nameEn?: string;
  nameEl?: string;

  // Description fields
  description?: string | null;
  descriptionEn?: string | null;
  descriptionEl?: string | null;

  // Price fields - multi-price menu system
  price: number;
  basePrice?: number | null;
  pickupPrice?: number | null;
  deliveryPrice?: number | null;  // Only available when Delivery module is acquired
  instorePrice?: number | null;   // Only available when Tables module is acquired

  // Display and media
  imageUrl?: string | null;

  // Preparation and nutrition
  preparationTime?: number | null;
  calories?: number | null;
  allergens?: string[] | null;
  ingredients?: string[] | null;

  // Availability and status
  isAvailable?: boolean | null;
  isFeatured?: boolean | null;
  isCustomizable?: boolean | null;
  isActive?: boolean | null;
  maxIngredients?: number | null;
  flavorType?: 'savory' | 'sweet' | 'all' | null;

  // Display ordering
  displayOrder?: number | null;

  // Timestamps
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * Canonical order type for price selection
 * This is the normalized type used throughout the pricing system
 */
export type OrderType = 'delivery' | 'pickup' | 'dine-in';

/**
 * Input order type values - these are all the variants that might come from UI/external sources
 * Includes legacy values (takeaway, dine_in) that need normalization
 */
export type OrderTypeInput = 'delivery' | 'pickup' | 'takeaway' | 'dine-in' | 'dine_in' | 'drive-through';

/**
 * Price type corresponding to order types
 */
export type PriceType = 'delivery' | 'pickup' | 'instore';

/**
 * Normalizes various order type input values to the canonical OrderType
 * This handles legacy values like 'takeaway' (-> 'pickup') and 'dine_in' (-> 'dine-in')
 *
 * @param input - Any order type input value
 * @returns Normalized canonical OrderType
 */
export function normalizeOrderType(input: OrderTypeInput | string | undefined): OrderType {
  if (!input) return 'pickup';

  switch (input) {
    case 'delivery':
      return 'delivery';
    case 'pickup':
    case 'takeaway':
    case 'drive-through':
      return 'pickup';
    case 'dine-in':
    case 'dine_in':
      return 'dine-in';
    default:
      return 'pickup';
  }
}

/**
 * Maps order type to the corresponding price type
 */
export function orderTypeToPriceType(orderType: OrderType | OrderTypeInput): PriceType {
  const normalized = normalizeOrderType(orderType);
  switch (normalized) {
    case 'delivery':
      return 'delivery';
    case 'pickup':
      return 'pickup';
    case 'dine-in':
      return 'instore';
    default:
      return 'pickup';
  }
}

/**
 * Gets the appropriate price for a menu item based on order type
 * Implements fallback logic: specific price -> pickupPrice -> price
 * Accepts any order type input variant and normalizes it internally
 *
 * @param item - The menu item
 * @param orderType - The order type (delivery, pickup, dine-in, takeaway, dine_in, etc.)
 * @returns The appropriate price for the order type
 */
export function getMenuItemPrice(item: MenuItem, orderType: OrderType | OrderTypeInput | string): number {
  const priceType = orderTypeToPriceType(orderType as OrderTypeInput);

  switch (priceType) {
    case 'delivery':
      return item.deliveryPrice ?? item.pickupPrice ?? item.price;
    case 'instore':
      return item.instorePrice ?? item.pickupPrice ?? item.price;
    case 'pickup':
    default:
      return item.pickupPrice ?? item.price;
  }
}

/**
 * Database row type for menu_items table (snake_case)
 * Used for direct database operations
 */
export interface MenuItemRow {
  id: string;
  category_id: string;
  organization_id?: string | null;
  name_en?: string;
  name_el?: string;
  name?: string; // Legacy/DB field fallback
  description_en?: string | null;
  description_el?: string | null;
  price: number;
  base_price?: number | null;
  pickup_price?: number | null;
  delivery_price?: number | null;
  instore_price?: number | null;
  image_url?: string | null;
  preparation_time?: number | null;
  allergens?: string[] | null;
  is_available?: boolean | null;
  is_customizable?: boolean | null;
  max_ingredients?: number | null;
  display_order?: number | null;
  ingredients?: any[] | null; // Raw ingredients from join
  flavor_type?: 'savory' | 'sweet' | 'all' | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Converts a database row to a MenuItem interface
 */
export function menuItemFromRow(row: MenuItemRow): MenuItem {
  // Map raw ingredients from join to string array of IDs if present
  const mappedIngredients = Array.isArray(row.ingredients)
    ? row.ingredients.map((i: any) => i.ingredient?.id || i.ingredient_id || i.id).filter(Boolean)
    : undefined;

  return {
    id: row.id,
    categoryId: row.category_id,
    organizationId: row.organization_id,
    nameEn: row.name_en ?? row.name,
    nameEl: row.name_el ?? row.name, // Fallback to name if el is missing
    name: row.name ?? row.name_en, // Fill name too just in case
    descriptionEn: row.description_en,
    descriptionEl: row.description_el,
    // Fix price mapping: DB uses base_price mostly, price might be missing or aliased
    price: row.price ?? row.base_price ?? 0,
    basePrice: row.base_price,
    pickupPrice: row.pickup_price ?? (row.price ?? row.base_price ?? 0), // Use price as fallback for specific prices
    deliveryPrice: row.delivery_price ?? (row.price ?? row.base_price ?? 0),
    instorePrice: row.instore_price ?? (row.price ?? row.base_price ?? 0),
    imageUrl: row.image_url,
    preparationTime: row.preparation_time,
    allergens: row.allergens,
    ingredients: mappedIngredients,
    // Map flavor_type
    flavorType: row.flavor_type,
    isAvailable: row.is_available,
    isCustomizable: row.is_customizable,
    maxIngredients: row.max_ingredients,
    displayOrder: row.display_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Converts a MenuItem to a database row format
 */
export function menuItemToRow(item: Partial<MenuItem>): Partial<MenuItemRow> {
  const row: Partial<MenuItemRow> = {};

  if (item.id !== undefined) row.id = item.id;
  if (item.categoryId !== undefined) row.category_id = item.categoryId;
  if (item.organizationId !== undefined) row.organization_id = item.organizationId;
  if (item.nameEn !== undefined) row.name_en = item.nameEn;
  if (item.nameEl !== undefined) row.name_el = item.nameEl;
  if (item.descriptionEn !== undefined) row.description_en = item.descriptionEn;
  if (item.descriptionEl !== undefined) row.description_el = item.descriptionEl;
  if (item.price !== undefined) row.price = item.price;
  if (item.basePrice !== undefined) row.base_price = item.basePrice;
  if (item.pickupPrice !== undefined) row.pickup_price = item.pickupPrice;
  if (item.deliveryPrice !== undefined) row.delivery_price = item.deliveryPrice;
  if (item.instorePrice !== undefined) row.instore_price = item.instorePrice;
  if (item.imageUrl !== undefined) row.image_url = item.imageUrl;
  if (item.preparationTime !== undefined) row.preparation_time = item.preparationTime;
  if (item.allergens !== undefined) row.allergens = item.allergens;
  if (item.isAvailable !== undefined) row.is_available = item.isAvailable;
  if (item.isCustomizable !== undefined) row.is_customizable = item.isCustomizable;
  if (item.maxIngredients !== undefined) row.max_ingredients = item.maxIngredients;
  if (item.displayOrder !== undefined) row.display_order = item.displayOrder;

  return row;
}

/**
 * Menu Category interface (snake_case matching DB for now, or normalized?)
 * Following existing pattern in MenuService.ts
 */
export interface MenuCategory {
  id: string;
  name_en?: string;
  name_el?: string;
  name?: string; // Fallback
  description_en: string | null;
  description_el: string | null;
  display_order: number | null;
  is_active: boolean;
  sort_order?: number;
}

export interface IngredientCategory {
  id: string;
  name_en?: string;
  name_el?: string;
  name?: string; // Fallback
  display_order: number | null;
  is_active: boolean;
  is_multiselect: boolean;
  min_selection: number;
  max_selection: number;
  flavor_type?: 'savory' | 'sweet' | null;
  color_code?: string;
}

export interface Ingredient {
  id: string;
  category_id: string;
  category_name?: string | null; // Category name from ingredient_categories for display
  category_display_order?: number | null; // Category display order for sorting
  name_en: string;
  name_el: string;
  price: number;
  pickupPrice?: number | null;
  deliveryPrice?: number | null;
  instorePrice?: number | null;
  is_available: boolean;
  display_order: number | null;
  price_modifier?: number; // Alias for price in customization context
  item_color?: string;
  flavor_type?: 'savory' | 'sweet' | null;
  color_code?: string; // Derived from category if needed
}
