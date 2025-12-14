import { supabase } from '../../shared/supabase';
import { getApiUrl } from '../../config/environment';
import { ErrorFactory, ErrorHandler, withTimeout, withRetry, POSError } from '../../shared/utils/error-handler';
import { TIMING, RETRY } from '../../shared/constants';
import { isOwnEvent, addSessionId } from '../utils/session-utils';

// Enhanced interfaces matching database schema
/**
 * MenuCategory interface
 * Database table: menu_categories
 *
 * Raw DB fields: name_en (NOT NULL), name_el (NOT NULL), name (NOT NULL),
 *                description_en, description_el, description
 * Computed fields: name (from name_en), description (from description_en)
 */
export interface MenuCategory {
  id: string;
  name?: string; // Computed field: name_en || name || 'Unknown'
  name_en?: string; // DB field (NOT NULL in DB, but optional after normalization)
  name_el?: string; // DB field (NOT NULL in DB, but optional after normalization)
  description?: string | null; // Computed field: description_en || description || ''
  description_en?: string | null; // DB field (nullable)
  description_el?: string | null; // DB field (nullable)
  image_url?: string | null;
  sort_order?: number; // Computed field (alias for display_order)
  display_order?: number | null;
  is_active?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface IngredientCategory {
  id: string;
  name: string;
  description?: string;
  color_code: string;
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Ingredient interface
 * Database table: ingredients
 *
 * Raw DB fields: name_en (NOT NULL), name_el (NOT NULL), name (NOT NULL),
 *                category_id (NULLABLE - may be null if no ingredient category assigned),
 *                current_stock (numeric), stock_quantity (integer),
 *                minimum_stock (numeric), min_stock_level (integer),
 *                cost_per_unit (numeric)
 * Computed fields: name (from name_en), cost (from cost_per_unit),
 *                  stock_quantity (from stock_quantity or current_stock),
 *                  min_stock_level (from min_stock_level or minimum_stock)
 */
export interface Ingredient {
  id: string;
  category_id?: string; // DB field (NULLABLE) - may be empty if no category assigned
  name: string; // Computed field: name_en || name || 'Unknown'
  name_en?: string; // English name from database
  name_el?: string; // Greek name from database
  description?: string;
  price: number;
  pickup_price?: number; // Order-type specific add-on price (pickup)
  delivery_price?: number; // Order-type specific add-on price (delivery)
  cost: number; // Computed from cost_per_unit
  image_url?: string;
  stock_quantity: number; // Computed from stock_quantity or current_stock
  min_stock_level: number; // Computed from min_stock_level or minimum_stock
  is_available: boolean;
  allergens?: string[];
  nutritional_info?: any;
  display_order: number;
  item_color?: string; // Hex color code for grouping/display
  flavor_type?: 'savory' | 'sweet' | null; // Flavor classification
  created_at: string;
  updated_at: string;
  ingredient_category?: IngredientCategory;
}

/**
 * MenuItem interface
 * Database table: subcategories (historical name - actually stores menu items)
 *
 * Raw DB fields: name (NOT NULL, single-language only), category_id (NOT NULL),
 *                price (NOT NULL), base_price (nullable), pickup_price, delivery_price
 * Computed fields: preparationTime (alias for preparation_time)
 * Deprecated fields: category (use category_id instead)
 */
export interface MenuItem {
  id: string;
  category_id: string; // DB field (NOT NULL) - use for filtering
  name?: string; // DB field (NOT NULL in DB, single-language only)
  name_en?: string; // Not in DB - for future bilingual support
  name_el?: string; // Not in DB - for future bilingual support
  description?: string | null; // DB field (nullable)
  description_en?: string | null; // Not in DB - for future bilingual support
  description_el?: string | null; // Not in DB - for future bilingual support
  price: number; // DB field (NOT NULL) - primary price
  base_price?: number; // DB field (nullable) - fallback price
  pickup_price?: number; // DB field (NOT NULL) - pickup-specific price
  delivery_price?: number; // DB field (NOT NULL) - delivery-specific price
  image_url?: string | null; // DB field (nullable)
  preparation_time?: number | null; // DB field (nullable, default 0)
  preparationTime?: number; // Computed field (alias for preparation_time)
  calories?: number | null; // DB field (nullable)
  allergens?: string[] | null; // DB field (nullable array)
  ingredients?: string[] | null; // Not in DB - for future use
  is_available?: boolean | null; // DB field (NOT NULL, default true)
  is_featured?: boolean; // DB field (NOT NULL, default false)
  is_customizable?: boolean; // DB field (nullable, default false)
  is_active?: boolean; // DB field (NOT NULL, default true)
  max_ingredients?: number; // DB field (nullable, default 0)
  sort_order?: number; // Computed field (deprecated, use display_order)
  display_order?: number | null; // DB field (NOT NULL, default 0)
  flavor_type?: 'savory' | 'sweet' | null; // DB field (nullable) - flavor classification
  created_at?: string | null;
  updated_at?: string | null;

  // Computed properties for compatibility
  /** @deprecated Use category_id instead */
  category?: string; // Computed field (alias for category_id)
  customizations?: MenuItemCustomization[]; // For menu items with customizable options
}

export interface MenuItemCustomizationOption {
  id: string;
  name: string;
  price: number;
}

export interface MenuItemCustomization {
  id: string;
  name: string;
  required: boolean;
  maxSelections?: number;
  options: MenuItemCustomizationOption[];
}

/**
 * Raw database types (pre-normalization)
 *
 * These types represent data as it comes directly from Supabase queries,
 * before being normalized by the service layer. They use `Record<string, any>`
 * to allow flexible field access while maintaining type safety at normalization boundaries.
 *
 * Usage:
 * - Use these types for Supabase query results
 * - Pass to normalization methods (normalizeMenuItem, normalizeMenuCategory, etc.)
 * - After normalization, data conforms to the typed interfaces above
 */
type RawMenuCategory = Record<string, any>;
type RawMenuItem = Record<string, any>;
type RawIngredient = Record<string, any>;

export interface MenuItemIngredient {
  id: string;
  menu_item_id: string;
  ingredient_id: string;
  quantity: number;
  is_default: boolean;
  is_optional: boolean;
  additional_price: number;
}

export interface CustomizationPreset {
  id: string;
  menu_item_id: string;
  name: string;
  description?: string;
  preset_ingredients: Array<{ ingredient_id: string; quantity: number }>;
  total_additional_price: number;
  image_url?: string;
  is_popular: boolean;
  display_order: number;
}

class MenuService {
  private static instance: MenuService;
  private cache: Map<string, any> = new Map();
  private lastFetch: Map<string, number> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private loadingStates: Map<string, 'loading' | 'loaded' | 'error'> = new Map();
  private errorHandler = ErrorHandler.getInstance();

  static getInstance(): MenuService {
    if (!MenuService.instance) {
      MenuService.instance = new MenuService();
    }
    return MenuService.instance;
  }

  private isCacheValid(key: string): boolean {
    const lastFetch = this.lastFetch.get(key);
    return lastFetch ? Date.now() - lastFetch < this.CACHE_TTL : false;
  }

  private setCache(key: string, data: any): void {
    this.cache.set(key, data);
    this.lastFetch.set(key, Date.now());
  }

  getLoadingStatus(): {
    menuItems: 'loading' | 'loaded' | 'error';
    categories: 'loading' | 'loaded' | 'error';
    ingredients: 'loading' | 'loaded' | 'error';
  } {
    return {
      menuItems: this.loadingStates.get('menu_items') || 'loaded',
      categories: this.loadingStates.get('menu_categories') || 'loaded',
      ingredients: this.loadingStates.get('ingredients') || 'loaded'
    };
  }

  async getMenuCategories(): Promise<MenuCategory[]> {
    const cacheKey = 'menu_categories';

    // Return cached data if valid
    if (this.isCacheValid(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Set loading state
    this.loadingStates.set(cacheKey, 'loading');

    try {
      // Wrap Supabase query with timeout and retry
      const { data, error } = await withRetry(async () => {
        return await withTimeout(
          (async () => {
            return await supabase
              .from('menu_categories')
              .select('*')
              .eq('is_active', true)
              .order('display_order', { ascending: true });
          })(),
          TIMING.MENU_LOAD_TIMEOUT,
          'Fetch menu categories'
        );
      }, RETRY.MAX_RETRY_ATTEMPTS, RETRY.RETRY_DELAY_MS) as any;

      if (error) {
        throw ErrorFactory.network('Failed to fetch menu categories');
      }

      // Filter out RLS test data (categories with "RLS" in the name)
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || item.name_en || '').toLowerCase();
        return !name.includes('rls');
      });

      const normalized = filteredData.map((item: any) => this.normalizeMenuCategory(item));
      this.setCache(cacheKey, normalized);
      this.loadingStates.set(cacheKey, 'loaded');
      return normalized;
    } catch (error) {
      // Set error state
      this.loadingStates.set(cacheKey, 'error');

      // Log error
      const posError = this.errorHandler.handle(error);
      console.error('Error fetching menu categories:', posError);

      // Check if cached data exists and return it with warning
      if (this.cache.has(cacheKey)) {
        console.warn('Returning cached menu categories due to error');
        return this.cache.get(cacheKey);
      }

      // Return empty array as graceful fallback
      return [];
    }
  }

  async getIngredientCategories(): Promise<IngredientCategory[]> {
    try {
      const { data, error } = await supabase
        .from('ingredient_categories')
        .select('*')
        .eq('is_active', true)
        .order('display_order');

      if (error) {
        console.error('Error fetching ingredient categories:', error);
        return [];
      }

      // Filter out RLS test data
      const filteredData = (data || []).filter((cat: any) => {
        const name = (cat.name || '').toLowerCase();
        return !name.includes('rls');
      });

      return filteredData.map(cat => ({
        id: cat.id,
        name: cat.name,
        description: cat.description || '',
        color_code: cat.color_code || '#000000',
        display_order: cat.display_order || 0,
        is_active: cat.is_active ?? true,
        created_at: cat.created_at,
        updated_at: cat.updated_at
      }));
    } catch (error) {
      console.error('Error fetching ingredient categories:', error);
      return [];
    }
  }

  async getIngredients(): Promise<Ingredient[]> {
    const cacheKey = 'ingredients';

    // Return cached data if valid
    if (this.isCacheValid(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Set loading state
    this.loadingStates.set(cacheKey, 'loading');

    try {
      // First, fetch all ingredient categories to build a flavor_type lookup map
      // This handles hierarchical categories where subcategories inherit flavor_type from parent
      const { data: categoriesData } = await supabase
        .from('ingredient_categories')
        .select('id, name, flavor_type, parent_id');

      // Build category lookup map: category_id -> flavor_type (inheriting from parent if needed)
      const categoryFlavorMap = new Map<string, 'savory' | 'sweet' | null>();
      const categoriesById = new Map<string, any>();

      if (categoriesData) {
        // First pass: index all categories by id
        for (const cat of categoriesData) {
          categoriesById.set(cat.id, cat);
        }
        // Second pass: resolve flavor_type (direct or from parent)
        for (const cat of categoriesData) {
          let flavorType = cat.flavor_type;
          // If no direct flavor_type, check parent
          if (!flavorType && cat.parent_id) {
            const parent = categoriesById.get(cat.parent_id);
            if (parent?.flavor_type) {
              flavorType = parent.flavor_type;
            }
          }
          if (flavorType === 'sweet' || flavorType === 'savory') {
            categoryFlavorMap.set(cat.id, flavorType);
          }
        }
      }

      // Wrap Supabase query with timeout
      const { data, error } = await withTimeout(
        (async () => {
          return await supabase
            .from('ingredients')
            .select(`
              id,
              name,
              name_en,
              name_el,
              description,
              category_id,
              unit,
              stock_quantity,
              current_stock,
              min_stock_level,
              minimum_stock,
              cost_per_unit,
              price,
              pickup_price,
              delivery_price,
              allergen_info,
              is_available,
              is_active,
              image_url,
              display_order,
              item_color,
              created_at,
              updated_at,
              ingredient_categories (
                id,
                name,
                flavor_type,
                color_code
              )
            `)
            .eq('is_active', true)
            .order('display_order', { ascending: true });
        })(),
        TIMING.MENU_LOAD_TIMEOUT,
        'Fetch ingredients'
      ) as any;

      if (error) {
        throw ErrorFactory.network('Failed to fetch ingredients');
      }

      // Filter out RLS test data (ingredients with "RLS" in the name)
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || item.name_en || '').toLowerCase();
        return !name.includes('rls');
      });

      // Normalize ingredients, using the category flavor map for hierarchical flavor_type resolution
      const normalized = filteredData.map((raw: any) => this.normalizeIngredient(raw, categoryFlavorMap));
      this.setCache(cacheKey, normalized);
      this.loadingStates.set(cacheKey, 'loaded');
      return normalized;
    } catch (error) {
      // Set error state
      this.loadingStates.set(cacheKey, 'error');

      // Log error
      const posError = this.errorHandler.handle(error);
      console.error('Error fetching ingredients:', posError);

      // Check if cached data exists and return it with warning
      if (this.cache.has(cacheKey)) {
        console.warn('Returning cached ingredients due to error');
        return this.cache.get(cacheKey);
      }

      // Return empty array as graceful fallback
      return [];
    }
  }

  async getIngredientsByCategory(categoryId: string): Promise<Ingredient[]> {
    try {
      const { data, error } = await supabase
        .from('ingredients')
        .select(`
          id,
          name,
          name_en,
          name_el,
          description,
          category_id,
          unit,
          stock_quantity,
          current_stock,
          min_stock_level,
          minimum_stock,
          cost_per_unit,
          price,
          pickup_price,
          delivery_price,
          allergen_info,
          is_available,
          is_active,
          image_url,
          display_order,
          created_at,
          updated_at
        `)
        .eq('category_id', categoryId)
        .eq('is_active', true)
        .order('display_order', { ascending: true });

      if (error) {
        console.error('Error fetching ingredients by category:', error);
        return [];
      }

      // Filter out RLS test data
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || item.name_en || '').toLowerCase();
        return !name.includes('rls');
      });

      return filteredData.map((raw: any) => this.normalizeIngredient(raw));
    } catch (error) {
      console.error('Error fetching ingredients by category:', error);
      return [];
    }
  }

  /**
   * Normalize raw menu item data from database to MenuItem interface
   * Handles field mapping, fallbacks, and default values
   */
  private normalizeMenuItem(raw: RawMenuItem): MenuItem {
    return {
      id: raw.id,
      category_id: raw.category_id, // NOT NULL in DB
      name: raw.name, // Single field in subcategories table
      description: raw.description || '',
      price: raw.price || raw.base_price || 0,
      base_price: raw.base_price,
      pickup_price: raw.pickup_price || 0,
      delivery_price: raw.delivery_price || 0,
      image_url: raw.image_url,
      preparation_time: raw.preparation_time || 0,
      preparationTime: raw.preparation_time || 0, // Compatibility alias
      calories: raw.calories,
      allergens: raw.allergens || [],
      is_available: raw.is_available ?? true,
      is_featured: raw.is_featured ?? false,
      is_customizable: raw.is_customizable ?? false,
      max_ingredients: raw.max_ingredients || 0,
      display_order: raw.display_order || 0,
      is_active: raw.is_active ?? true,
      flavor_type: raw.flavor_type, // Add flavor_type for Sweet/Savory filtering
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      // Compatibility fields
      category: raw.category_id, // Deprecated: use category_id
    };
  }

  /**
   * Normalize raw menu category data from database to MenuCategory interface
   * Handles bilingual fields and fallbacks
   */
  private normalizeMenuCategory(raw: RawMenuCategory): MenuCategory {
    return {
      id: raw.id,
      name: raw.name_en || raw.name || 'Unknown',
      name_en: raw.name_en,
      name_el: raw.name_el,
      description: raw.description_en || raw.description || '',
      description_en: raw.description_en,
      description_el: raw.description_el,
      image_url: raw.image_url,
      display_order: raw.display_order || 0,
      sort_order: raw.display_order || 0, // Compatibility alias
      is_active: raw.is_active ?? true,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
    };
  }

  /**
   * Normalize raw ingredient data from database to Ingredient interface
   * Handles bilingual fields, stock fields, and nullable category_id
   * Extracts flavor_type using the pre-built category lookup map for hierarchical resolution
   * @param raw Raw ingredient data from database
   * @param categoryFlavorMap Optional map of category_id -> flavor_type (with parent inheritance already resolved)
   */
  private normalizeIngredient(raw: RawIngredient, categoryFlavorMap?: Map<string, 'savory' | 'sweet' | null>): Ingredient {
    // Extract flavor_type using the category lookup map (preferred - handles parent inheritance)
    // Falls back to direct category.flavor_type if map not provided
    let flavorType: 'savory' | 'sweet' | null = null;

    // First try the pre-built lookup map (handles parent category inheritance)
    if (categoryFlavorMap && raw.category_id) {
      flavorType = categoryFlavorMap.get(raw.category_id) || null;
    }

    // Fallback: try direct flavor_type from the joined category data
    if (!flavorType) {
      const category = (raw as any).ingredient_categories;
      if (category?.flavor_type) {
        const ft = category.flavor_type.toLowerCase();
        if (ft === 'sweet' || ft === 'savory') {
          flavorType = ft as 'savory' | 'sweet';
        }
      }
    }

    return {
      id: raw.id,
      category_id: raw.category_id || undefined, // NULLABLE in DB - may be undefined
      name: raw.name_en || raw.name || 'Unknown',
      description: raw.description || '',
      price: raw.price || 0,
      // Dual pricing for ingredients
      pickup_price: (raw as any).pickup_price ?? raw.price ?? 0,
      delivery_price: (raw as any).delivery_price ?? raw.price ?? 0,
      cost: raw.cost_per_unit || 0,
      image_url: raw.image_url,
      stock_quantity: raw.stock_quantity || Math.floor(raw.current_stock || 0),
      min_stock_level: raw.min_stock_level || Math.floor(raw.minimum_stock || 0),
      is_available: raw.is_available ?? true,
      allergens: raw.allergen_info || [],
      display_order: raw.display_order || 0,
      item_color: (raw as any).item_color || '#6B7280', // Default gray if not set
      flavor_type: flavorType, // From ingredient_categories.flavor_type field
      created_at: raw.created_at,
      updated_at: raw.updated_at,
    };
  }

  async getMenuItems(): Promise<MenuItem[]> {
    const cacheKey = 'menu_items';

    // Return cached data if valid
    if (this.isCacheValid(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Set loading state
    this.loadingStates.set(cacheKey, 'loading');

    try {
      // Wrap Supabase query with timeout and retry
      const { data, error } = await withRetry(async () => {
        return await withTimeout(
          (async () => {
            return await supabase
              .from('subcategories')
              .select('*')
              .order('display_order', { ascending: true });
          })(),
          TIMING.MENU_LOAD_TIMEOUT,
          'Fetch menu items'
        );
      }, RETRY.MAX_RETRY_ATTEMPTS, RETRY.RETRY_DELAY_MS) as any;

      if (error) {
        throw ErrorFactory.network('Failed to fetch menu items');
      }

      // Filter out RLS test data and inactive items (items with "RLS" in the name or "Test" prefix)
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || '').toLowerCase();
        // Filter out RLS test items and items that aren't active
        if (name.includes('rls') || name.startsWith('test ')) {
          return false;
        }
        // Only include active items
        return item.is_active !== false;
      });

      const normalized = filteredData.map((item: any) => this.normalizeMenuItem(item));
      this.setCache(cacheKey, normalized);
      this.loadingStates.set(cacheKey, 'loaded');
      return normalized;
    } catch (error) {
      // Set error state
      this.loadingStates.set(cacheKey, 'error');

      // Log error
      const posError = this.errorHandler.handle(error);
      console.error('Error fetching menu items:', posError);

      // Check if cached data exists and return it with warning
      if (this.cache.has(cacheKey)) {
        console.warn('Returning cached menu items due to error');
        return this.cache.get(cacheKey);
      }

      // Return empty array as graceful fallback
      return [];
    }
  }

  async getMenuItemById(itemId: string): Promise<MenuItem | null> {
    try {
      const { data, error } = await withTimeout(
        (async () => {
          return await supabase
            .from('subcategories')
            .select('*')
            .eq('id', itemId)
            .eq('is_active', true)
            .single();
        })(),
        10000,
        'getMenuItemById timeout'
      );

      if (error) {
        console.error('Error fetching menu item by ID:', error);
        return null;
      }

      if (!data) {
        return null;
      }

      // Transform the data to match MenuItem interface
      return {
        id: data.id,
        category_id: data.category_id,
        name: data.name || data.name_en || 'Unknown',
        description: data.description,
        price: data.price || data.base_price || 0,
        base_price: data.base_price,
        pickup_price: data.pickup_price,
        delivery_price: data.delivery_price,
        image_url: data.image_url,
        is_available: data.is_available ?? true,
        is_customizable: data.is_customizable ?? false,
        preparationTime: data.preparation_time || 15,
        preparation_time: data.preparation_time,
        display_order: data.display_order || 0,
        created_at: data.created_at,
        updated_at: data.updated_at,
        // category is deprecated, use category_id instead
        category: data.category_id
      };
    } catch (error) {
      console.error('Error in getMenuItemById:', error);
      return null;
    }
  }

  async getMenuItemsByCategory(categoryId: string): Promise<MenuItem[]> {
    const cacheKey = `menu_items_${categoryId}`;

    // Return cached data if valid
    if (this.isCacheValid(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      // Wrap Supabase query with timeout
      const { data, error } = await withTimeout(
        (async () => {
          return await supabase
            .from('subcategories')
            .select(`
              *,
              category:menu_categories(*)
            `)
            .eq('category_id', categoryId)
            .eq('is_available', true)
            .order('display_order', { ascending: true });
        })(),
        TIMING.MENU_LOAD_TIMEOUT,
        'Fetch menu items by category'
      ) as any;

      if (error) {
        throw ErrorFactory.network('Failed to fetch menu items by category');
      }

      const normalized = (data || []).map((item: any) => this.normalizeMenuItem(item));
      this.setCache(cacheKey, normalized);
      return normalized;
    } catch (error) {
      // Log error
      const posError = this.errorHandler.handle(error);
      console.error('Error fetching menu items by category:', posError);

      // Check if cached data exists and return it with warning
      if (this.cache.has(cacheKey)) {
        console.warn('Returning cached menu items by category due to error');
        return this.cache.get(cacheKey);
      }

      // Return empty array as graceful fallback
      return [];
    }
  }

  async getCustomizableItems(): Promise<MenuItem[]> {
    const cacheKey = 'customizable_items';

    // Return cached data if valid
    if (this.isCacheValid(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      // Wrap Supabase query with timeout
      const { data, error } = await withTimeout(
        (async () => {
          return await supabase
            .from('subcategories')
            .select(`
              *,
              category:menu_categories(*)
            `)
            .eq('is_customizable', true)
            .eq('is_available', true)
            .order('display_order', { ascending: true });
        })(),
        TIMING.MENU_LOAD_TIMEOUT,
        'Fetch customizable items'
      ) as any;

      if (error) {
        throw ErrorFactory.network('Failed to fetch customizable items');
      }

      const normalized = (data || []).map((item: any) => this.normalizeMenuItem(item));
      this.setCache(cacheKey, normalized);
      return normalized;
    } catch (error) {
      // Log error
      const posError = this.errorHandler.handle(error);
      console.error('Error fetching customizable items:', posError);

      // Check if cached data exists and return it with warning
      if (this.cache.has(cacheKey)) {
        console.warn('Returning cached customizable items due to error');
        return this.cache.get(cacheKey);
      }

      // Return empty array as graceful fallback
      return [];
    }
  }

  async getMenuItemIngredients(menuItemId: string): Promise<MenuItemIngredient[]> {
    try {
      const { data, error } = await supabase
        .from('subcategory_ingredients')
        .select(`
          subcategory_id,
          ingredient_id,
          quantity,
          ingredients(
            id,
            name_en,
            name_el,
            cost_per_unit
          )
        `)
        .eq('subcategory_id', menuItemId);

      if (error) {
        console.error('Error fetching menu item ingredients:', error);
        return [];
      }

      return (data || []).map((item, index) => ({
        id: `${item.subcategory_id}-${item.ingredient_id}`,
        menu_item_id: item.subcategory_id,
        ingredient_id: item.ingredient_id,
        quantity: item.quantity ?? 1,
        is_default: true,
        is_optional: false,
        additional_price: 0
      }));
    } catch (error) {
      console.error('Error fetching menu item ingredients:', error);
      return [];
    }
  }

  async getCustomizationPresets(menuItemId: string): Promise<CustomizationPreset[]> {
    // Note: Simplified version - customization not implemented in current database
    console.warn('getCustomizationPresets: Feature not available in current database schema');
    return [];
  }

  // Helper method to get available ingredients for a customizable item
  async getAvailableIngredientsForItem(menuItemId: string): Promise<Ingredient[]> {
    // Note: Simplified version - complex ingredient management not implemented
    console.warn('getAvailableIngredientsForItem: Feature not available in current database schema');
    return [];
  }

  // Method to calculate total price with customizations
  calculateItemPrice(basePrice: number, selectedIngredients: Array<{ ingredient: Ingredient; quantity: number }>): number {
    const ingredientTotal = selectedIngredients.reduce((total, item) => {
      return total + (item.ingredient.price * item.quantity);
    }, 0);
    
    return basePrice + ingredientTotal;
  }

  // Method to check ingredient availability and update stock
  async checkIngredientAvailability(ingredientId: string): Promise<boolean> {
    try {
      // TODO: Ingredients table not yet created in database schema
      // const { data, error } = await supabase
      //   .from('ingredients')
      //   .select('is_available, stock_quantity, min_stock_level')
      //   .eq('id', ingredientId)
      //   .single();

      // if (error || !data) {
      //   return false;
      // }

      // return data.is_available && data.stock_quantity > data.min_stock_level;
      
      // Temporary: return true for all ingredients until ingredients table is created
      return true;
    } catch (error) {
      console.error('Error checking ingredient availability:', error);
      return false;
    }
  }

  // Admin Dashboard Integration Methods
  async getAdminDashboardSettings(): Promise<any> {
    const cacheKey = 'admin_settings';
    
    if (this.isCacheValid(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      const response = await fetch(getApiUrl('/settings/pos'), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch admin settings');
      }

      const settings = await response.json();
      this.setCache(cacheKey, settings);
      return settings;
    } catch (error) {
      console.error('Error fetching admin dashboard settings:', error);
      return {
        tax_rate: 0.24, // Default Greek VAT
        service_fee: 0,
        delivery_fee: 2.50,
        currency: 'EUR',
        timezone: 'Europe/Athens'
      };
    }
  }

  async getMenuConfiguration(): Promise<any> {
    const cacheKey = 'menu_configuration';
    
    if (this.isCacheValid(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      const response = await fetch(getApiUrl('/settings/menu'), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch menu configuration');
      }

      const config = await response.json();
      this.setCache(cacheKey, config);
      return config;
    } catch (error) {
      console.error('Error fetching menu configuration:', error);
      return {
        enable_customization: true,
        max_customizations: 10,
        preparation_time_buffer: 5,
        auto_categorize: true
      };
    }
  }

  // Clear cache (useful for real-time updates)
  clearCache(): void {
    this.cache.clear();
    this.lastFetch.clear();
  }

  // Clear specific cache entry
  clearCacheEntry(key: string): void {
    this.cache.delete(key);
    this.lastFetch.delete(key);
  }

  // Subscribe to real-time updates using subscription manager
  // Enhanced with event details and granular cache invalidation
  subscribeToMenuUpdates(callback: (evt?: { table: string; eventType: string; new?: any; old?: any; }) => void): () => void {
    // DISABLED: Real-time subscriptions are now handled by the main process (sync-service)
    // to prevent multiple WebSocket connections which cause connection failures.
    console.log('[MenuService] Real-time subscriptions disabled - using main process IPC instead');

    // Return a no-op unsubscribe function
    return () => {};

    /* DISABLED - All real-time subscriptions handled by main process
    const { subscriptionManager } = require('./SubscriptionManager');

    // Track unsubscribe functions (may be null if subscription failed)
    const unsubscribeFunctions: Array<(() => void) | null> = [];

    // Subscribe to all menu-related tables through the subscription manager
    // Wrap each subscription in try/catch for resilience
    try {
      const unsubscribeMenuItems = subscriptionManager.subscribe('menu-items-updates', {
        table: 'subcategories',
        event: '*',
        callback: (payload: any) => {
          // Skip own events to avoid double-processing
          if (isOwnEvent(payload.new?.client_session_id || payload.old?.client_session_id)) {
            console.log('⏭️ POS: Skipping own subcategories event');
            return;
          }

          const event = {
            table: 'subcategories',
            eventType: payload.eventType,
            new: payload.new,
            old: payload.old
          };

          // Granular cache invalidation based on event type
          if (payload.eventType === 'UPDATE') {
            this.clearCacheEntry('menu_items');
            // Invalidate category-specific cache if category_id is present
            if (payload.new?.category_id) {
              this.clearCacheEntry(`menu_items_${payload.new.category_id}`);
            }
            if (payload.old?.category_id && payload.old.category_id !== payload.new?.category_id) {
              this.clearCacheEntry(`menu_items_${payload.old.category_id}`);
            }
          } else {
            // For INSERT/DELETE, invalidate all menu items cache
            this.clearCacheEntry('menu_items');
            this.clearCacheEntry('customizable_items');
          }

          callback(event);
        }
      });
      unsubscribeFunctions.push(unsubscribeMenuItems);
    } catch (error) {
      console.error('Failed to subscribe to menu items updates:', error);
      unsubscribeFunctions.push(null);
    }

    try {
      const unsubscribeIngredients = subscriptionManager.subscribe('ingredients-updates', {
        table: 'ingredients',
        event: '*',
        callback: (payload: any) => {
          // Skip own events to avoid double-processing
          if (isOwnEvent(payload.new?.client_session_id || payload.old?.client_session_id)) {
            console.log('⏭️ POS: Skipping own ingredients event');
            return;
          }

          const event = {
            table: 'ingredients',
            eventType: payload.eventType,
            new: payload.new,
            old: payload.old
          };

          // Invalidate ingredients cache
          this.clearCacheEntry('ingredients');
          this.clearCacheEntry('customizable_items');

          callback(event);
        }
      });
      unsubscribeFunctions.push(unsubscribeIngredients);
    } catch (error) {
      console.error('Failed to subscribe to ingredients updates:', error);
      unsubscribeFunctions.push(null);
    }

    try {
      const unsubscribeCategories = subscriptionManager.subscribe('menu-categories-updates', {
        table: 'menu_categories',
        event: '*',
        callback: (payload: any) => {
          // Skip own events to avoid double-processing
          if (isOwnEvent(payload.new?.client_session_id || payload.old?.client_session_id)) {
            console.log('⏭️ POS: Skipping own menu_categories event');
            return;
          }

          const event = {
            table: 'menu_categories',
            eventType: payload.eventType,
            new: payload.new,
            old: payload.old
          };

          // Invalidate categories cache
          this.clearCacheEntry('menu_categories');
          // Category changes may affect menu items, so invalidate those too
          this.clearCacheEntry('menu_items');

          callback(event);
        }
      });
      unsubscribeFunctions.push(unsubscribeCategories);
    } catch (error) {
      console.error('Failed to subscribe to categories updates:', error);
      unsubscribeFunctions.push(null);
    }

    // Return combined unsubscribe function that is safe even if some subscriptions failed
    return () => {
      unsubscribeFunctions.forEach(unsubscribe => {
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch (error) {
            console.error('Error during unsubscribe:', error);
          }
        }
      });
    };
    */
  }
}

export const menuService = MenuService.getInstance();