/**
 * Menu Combo Type Definitions
 * Shared types for menu combos/bundles across all applications
 *
 * These types support the menu combo system with:
 * - Fixed combos (pre-defined items)
 * - Choice combos (some items picked from a category)
 * - BOGO offers (buy X get Y free/discounted)
 * - Multi-price support (pickup/delivery/dine-in)
 * - Time-based availability restrictions
 * - Ingredient customization support
 */

import type { OrderType, OrderTypeInput, normalizeOrderType } from './menu';

// Re-export for convenience
export { normalizeOrderType } from './menu';

/** Combo type: fixed items, category choices, or buy-one-get-one */
export type ComboType = 'fixed' | 'choice' | 'bogo';

/** How a combo item slot is filled: specific item or pick from category */
export type ComboItemSelectionType = 'specific' | 'category_choice';

/** BOGO scope: what items the offer applies to */
export type BogoScope = 'all' | 'category' | 'specific_items';

/**
 * Menu Combo interface representing a combo/bundle
 */
export interface MenuCombo {
  id: string;
  organization_id: string;
  branch_id?: string | null;

  // Combo type
  combo_type: ComboType;

  // Identity (bilingual)
  name_en: string;
  name_el?: string | null;
  description_en?: string | null;
  description_el?: string | null;
  sku?: string | null;
  image_url?: string | null;

  // Multi-price support (fixed price per order type)
  base_price: number;
  pickup_price?: number | null;
  delivery_price?: number | null;
  dine_in_price?: number | null;

  // BOGO fields (only used when combo_type = 'bogo')
  buy_quantity?: number | null;
  get_quantity?: number | null;
  get_discount_percent?: number | null; // 0-100, where 100 = free
  bogo_scope?: BogoScope | null;
  bogo_category_ids?: string[] | null;

  // Time restrictions
  has_time_restriction: boolean;
  available_days: number[]; // 0=Sunday, 1=Monday, etc.
  start_time?: string | null; // HH:mm format
  end_time?: string | null; // HH:mm format
  valid_from?: string | null; // ISO timestamp
  valid_until?: string | null; // ISO timestamp

  // Customization
  allow_customization: boolean;

  // Status
  is_active: boolean;
  is_featured: boolean;
  display_order: number;

  // Timestamps
  created_at: string;
  updated_at: string;

  // Joined data (from menu_combo_items)
  items?: MenuComboItem[];
}

/**
 * Menu Combo Item interface representing an item within a combo
 */
export interface MenuComboItem {
  id: string;
  combo_id: string;
  subcategory_id?: string | null; // null for category_choice items
  quantity: number;
  display_order: number;
  created_at: string;

  // Enhanced combo item fields
  selection_type: ComboItemSelectionType; // 'specific' or 'category_choice'
  category_id?: string | null; // for category_choice: which category to pick from

  // Joined data (from subcategories table, for specific items)
  subcategory?: {
    id: string;
    name?: string;
    name_en?: string;
    name_el?: string;
    base_price: number;
    pickup_price?: number | null;
    delivery_price?: number | null;
    dine_in_price?: number | null;
    image_url?: string | null;
    is_customizable: boolean;
    max_ingredients?: number | null;
    category_id?: string;
    category_name?: string;
  };

  // Joined data (from menu_categories table, for category_choice items)
  category?: {
    id: string;
    name?: string;
    name_en?: string;
    name_el?: string;
  };
}

/**
 * Database row type for menu_combos table (snake_case)
 */
export interface MenuComboRow {
  id: string;
  organization_id: string;
  branch_id?: string | null;
  combo_type: ComboType;
  name_en: string;
  name_el?: string | null;
  description_en?: string | null;
  description_el?: string | null;
  sku?: string | null;
  image_url?: string | null;
  base_price: number;
  pickup_price?: number | null;
  delivery_price?: number | null;
  dine_in_price?: number | null;
  buy_quantity?: number | null;
  get_quantity?: number | null;
  get_discount_percent?: number | null;
  bogo_scope?: BogoScope | null;
  bogo_category_ids?: string[] | null;
  has_time_restriction: boolean;
  available_days: number[];
  start_time?: string | null;
  end_time?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  allow_customization: boolean;
  is_active: boolean;
  is_featured: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
  items?: MenuComboItemRow[];
}

/**
 * Database row type for menu_combo_items table
 */
export interface MenuComboItemRow {
  id: string;
  combo_id: string;
  subcategory_id?: string | null;
  quantity: number;
  display_order: number;
  created_at: string;
  selection_type: ComboItemSelectionType;
  category_id?: string | null;
  subcategory?: Record<string, unknown>;
  category?: Record<string, unknown>;
}

/**
 * Order item combo details stored in order_items.combo_items JSONB
 */
export interface OrderComboItem {
  subcategory_id: string;
  name: string;
  name_en?: string;
  name_el?: string;
  quantity: number;
  unit_price: number;
  customizations?: OrderComboItemCustomization[];
}

/**
 * Customization applied to a combo item
 */
export interface OrderComboItemCustomization {
  ingredient_id: string;
  name: string;
  name_en?: string;
  name_el?: string;
  price: number;
  action: 'add' | 'remove' | 'extra';
}

/**
 * Get combo price for specific order type
 * Implements fallback logic: specific price -> pickup_price -> base_price
 *
 * @param combo - The menu combo
 * @param orderType - The order type (delivery, pickup, dine-in)
 * @returns The appropriate price for the order type
 */
export function getComboPrice(
  combo: MenuCombo,
  orderType: OrderType | OrderTypeInput | string
): number {
  // Normalize the order type
  const normalized = normalizeOrderTypeInternal(orderType);

  switch (normalized) {
    case 'delivery':
      return combo.delivery_price ?? combo.pickup_price ?? combo.base_price;
    case 'dine-in':
      return combo.dine_in_price ?? combo.pickup_price ?? combo.base_price;
    case 'pickup':
    default:
      return combo.pickup_price ?? combo.base_price;
  }
}

/**
 * Internal normalizer to avoid circular import issues
 */
function normalizeOrderTypeInternal(
  input: OrderType | OrderTypeInput | string | undefined
): 'delivery' | 'pickup' | 'dine-in' {
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
 * Check if combo is currently available based on time restrictions
 *
 * @param combo - The menu combo to check
 * @param referenceDate - Optional reference date (defaults to now)
 * @returns true if combo is available
 */
export function isComboAvailableNow(
  combo: MenuCombo,
  referenceDate?: Date
): boolean {
  if (!combo.is_active) return false;
  if (!combo.has_time_restriction) return true;

  const now = referenceDate ?? new Date();

  // Check valid_from/valid_until date range
  if (combo.valid_from && new Date(combo.valid_from) > now) return false;
  if (combo.valid_until && new Date(combo.valid_until) < now) return false;

  // Check day of week (0=Sunday)
  const dayOfWeek = now.getDay();
  if (!combo.available_days.includes(dayOfWeek)) return false;

  // Check time of day
  if (combo.start_time || combo.end_time) {
    const currentTime = now.toTimeString().slice(0, 5); // HH:mm
    if (combo.start_time && currentTime < combo.start_time) return false;
    if (combo.end_time && currentTime > combo.end_time) return false;
  }

  return true;
}

/**
 * Calculate savings for a combo compared to buying items individually
 *
 * @param combo - The menu combo
 * @param orderType - The order type for price calculation
 * @returns The savings amount (positive = money saved)
 */
export function calculateComboSavings(
  combo: MenuCombo,
  orderType: OrderType | OrderTypeInput | string = 'pickup'
): number {
  if (!combo.items || combo.items.length === 0) return 0;

  const comboPrice = getComboPrice(combo, orderType);
  const individualTotal = combo.items.reduce((sum, item) => {
    if (!item.subcategory) return sum;

    const itemPrice = getItemPriceForOrderType(item.subcategory, orderType);
    return sum + itemPrice * item.quantity;
  }, 0);

  return Math.max(0, individualTotal - comboPrice);
}

/**
 * Get item price for order type (helper for subcategory)
 */
function getItemPriceForOrderType(
  item: NonNullable<MenuComboItem['subcategory']>,
  orderType: OrderType | OrderTypeInput | string
): number {
  const normalized = normalizeOrderTypeInternal(orderType);

  switch (normalized) {
    case 'delivery':
      return item.delivery_price ?? item.pickup_price ?? item.base_price;
    case 'dine-in':
      // dine-in should use dine_in_price if available, then fall back to pickup/base
      return item.dine_in_price ?? item.pickup_price ?? item.base_price;
    case 'pickup':
    default:
      return item.pickup_price ?? item.base_price;
  }
}

/**
 * Convert database row to MenuCombo interface
 */
export function menuComboFromRow(row: MenuComboRow): MenuCombo {
  return {
    id: row.id,
    organization_id: row.organization_id,
    branch_id: row.branch_id,
    combo_type: row.combo_type || 'fixed',
    name_en: row.name_en,
    name_el: row.name_el,
    description_en: row.description_en,
    description_el: row.description_el,
    sku: row.sku,
    image_url: row.image_url,
    base_price: row.base_price,
    pickup_price: row.pickup_price,
    delivery_price: row.delivery_price,
    dine_in_price: row.dine_in_price,
    buy_quantity: row.buy_quantity,
    get_quantity: row.get_quantity,
    get_discount_percent: row.get_discount_percent,
    bogo_scope: row.bogo_scope,
    bogo_category_ids: row.bogo_category_ids,
    has_time_restriction: row.has_time_restriction,
    available_days: row.available_days,
    start_time: row.start_time,
    end_time: row.end_time,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    allow_customization: row.allow_customization,
    is_active: row.is_active,
    is_featured: row.is_featured,
    display_order: row.display_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: row.items?.map(menuComboItemFromRow),
  };
}

/**
 * Convert database row to MenuComboItem interface
 */
export function menuComboItemFromRow(row: MenuComboItemRow): MenuComboItem {
  const sub = row.subcategory as Record<string, unknown> | undefined;
  const cat = row.category as Record<string, unknown> | undefined;

  return {
    id: row.id,
    combo_id: row.combo_id,
    subcategory_id: row.subcategory_id,
    quantity: row.quantity,
    display_order: row.display_order,
    created_at: row.created_at,
    selection_type: (row.selection_type as ComboItemSelectionType) || 'specific',
    category_id: row.category_id,
    subcategory: sub
      ? {
          id: sub.id as string,
          name: (sub.name as string) ?? (sub.name_en as string),
          name_en: sub.name_en as string | undefined,
          name_el: sub.name_el as string | undefined,
          base_price: sub.base_price as number,
          pickup_price: sub.pickup_price as number | null | undefined,
          delivery_price: sub.delivery_price as number | null | undefined,
          dine_in_price: sub.dine_in_price as number | null | undefined,
          image_url: sub.image_url as string | null | undefined,
          is_customizable: (sub.is_customizable as boolean) ?? false,
          max_ingredients: sub.max_ingredients as number | null | undefined,
          category_id: sub.category_id as string | undefined,
          category_name: sub.category_name as string | undefined,
        }
      : undefined,
    category: cat
      ? {
          id: cat.id as string,
          name: (cat.name as string) ?? (cat.name_en as string),
          name_en: cat.name_en as string | undefined,
          name_el: cat.name_el as string | undefined,
        }
      : undefined,
  };
}

/** Check if combo is a BOGO type */
export function isBogoCombo(combo: MenuCombo): boolean {
  return combo.combo_type === 'bogo';
}

/** Check if combo is a choice type (has category_choice items) */
export function isChoiceCombo(combo: MenuCombo): boolean {
  return combo.combo_type === 'choice';
}

/**
 * Zod-compatible type for combo creation (without auto-generated fields)
 */
export interface CreateMenuComboInput {
  combo_type?: ComboType;
  name_en: string;
  name_el?: string;
  description_en?: string;
  description_el?: string;
  sku?: string;
  image_url?: string;
  base_price: number;
  pickup_price?: number;
  delivery_price?: number;
  dine_in_price?: number;
  // BOGO fields
  buy_quantity?: number;
  get_quantity?: number;
  get_discount_percent?: number;
  bogo_scope?: BogoScope;
  bogo_category_ids?: string[];
  // Time restrictions
  has_time_restriction?: boolean;
  available_days?: number[];
  start_time?: string;
  end_time?: string;
  valid_from?: string;
  valid_until?: string;
  allow_customization?: boolean;
  is_active?: boolean;
  is_featured?: boolean;
  display_order?: number;
  branch_id?: string;
  items?: CreateMenuComboItemInput[];
}

/**
 * Zod-compatible type for combo item creation
 */
export interface CreateMenuComboItemInput {
  subcategory_id?: string; // required for 'specific', null for 'category_choice'
  selection_type?: ComboItemSelectionType;
  category_id?: string; // required for 'category_choice'
  quantity?: number;
  display_order?: number;
}

/**
 * Zod-compatible type for combo update
 */
export interface UpdateMenuComboInput extends Partial<CreateMenuComboInput> {
  id?: string; // For patch operations
}
