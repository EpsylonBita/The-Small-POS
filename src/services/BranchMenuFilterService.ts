import { supabase } from '../shared/supabase'

interface MenuCategory {
  id: string
  name: string
  name_en?: string
  name_el?: string
  display_order: number
  is_active: boolean
}

interface MenuSubcategory {
  id: string
  category_id: string
  name: string
  name_en?: string
  name_el?: string
  description?: string
  // Legacy single price for backward compatibility
  price: number
  base_price?: number
  // Dual pricing
  pickup_price?: number
  delivery_price?: number
  is_available: boolean
  display_order: number
  // Override fields
  hasOverride?: boolean
  originalPrice?: number
  originalAvailability?: boolean
}

interface MenuIngredient {
  id: string
  category_id: string
  name: string
  name_en?: string
  name_el?: string
  unit: string
  // Legacy single price for backward compatibility
  price: number
  // Dual pricing for add-ons
  pickup_price?: number
  delivery_price?: number
  cost: number
  stock_quantity: number
  is_available: boolean
  // Override fields
  hasOverride?: boolean
  originalPrice?: number
  originalAvailability?: boolean
}

interface BranchOverride {
  id: string
  branch_id: string
  subcategory_id?: string | null
  ingredient_id?: string | null
  product_id?: string | null
  resource_type: 'product' | 'subcategory' | 'ingredient'
  app_name: string
  price_override?: number | null
  availability_override?: boolean | null
}

/**
 * Service to filter menu based on branch configuration
 * Integrates with real-time sync to update cache
 */
export class BranchMenuFilterService {
  private branchId: string | null
  private categoriesCache: Map<string, MenuCategory> = new Map()
  private subcategoriesCache: Map<string, MenuSubcategory> = new Map()
  private ingredientsCache: Map<string, MenuIngredient> = new Map()
  private overridesCache: Map<string, BranchOverride> = new Map()
  private initialized: boolean = false

  constructor(branchId: string | null) {
    this.branchId = branchId
  }

  /**
   * Initialize service and load menu data with overrides
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    try {
      // Load from localStorage first for offline support
      this.loadFromLocalStorage()

      // Load overrides FIRST before loading items so they're ready
      await this.loadOverrides()

      // Then fetch menu data (categories, subcategories, ingredients)
      // These will apply overrides during loading
      await Promise.all([
        this.loadCategories(),
        this.loadSubcategories(),
        this.loadIngredients(),
      ])

      // Save to localStorage for offline access
      this.saveToLocalStorage()

      this.initialized = true
    } catch (error) {
      console.error('Error initializing BranchMenuFilterService:', error)
      // Continue with cached data if available
      if (this.subcategoriesCache.size > 0 || this.ingredientsCache.size > 0) {
        this.initialized = true
      } else {
        throw error
      }
    }
  }

  /**
   * Load categories from database
   */
  private async loadCategories(): Promise<void> {
    const { data, error } = await supabase
      .from('menu_categories')
      .select('*')
      .eq('is_active', true)
      .order('display_order', { ascending: true })

    if (error) throw error

    this.categoriesCache.clear()
    data?.forEach((cat) => {
      this.categoriesCache.set(cat.id, cat)
    })
  }

  /**
   * Load subcategories with branch overrides
   */
  private async loadSubcategories(): Promise<void> {
    const { data, error } = await supabase
      .from('subcategories')
      .select('*')
      .order('display_order', { ascending: true })

    if (error) throw error

    this.subcategoriesCache.clear()
    data?.forEach((sub) => {
      // Apply overrides if branch is selected
      const overrideKey = `subcategory:${sub.id}`
      const override = this.overridesCache.get(overrideKey)

      const item: MenuSubcategory = {
        ...sub,
        // Preserve legacy price for compatibility
        price: (override?.price_override ?? sub.base_price ?? sub.price) as number,
        // Dual pricing: apply same override to both if provided (schema currently stores single override)
        pickup_price: (override?.price_override ?? sub.pickup_price ?? sub.base_price ?? sub.price) as number,
        delivery_price: (override?.price_override ?? sub.delivery_price ?? sub.base_price ?? sub.price) as number,
        is_available: (override?.availability_override ?? sub.is_available) as boolean,
        hasOverride: !!override,
        originalPrice: sub.base_price ?? sub.price,
        originalAvailability: sub.is_available,
      }

      this.subcategoriesCache.set(sub.id, item)
    })
  }

  /**
   * Load ingredients with branch overrides
   */
  private async loadIngredients(): Promise<void> {
    const { data, error } = await supabase
      .from('ingredients')
      .select('*')
      .order('name', { ascending: true })

    if (error) throw error

    this.ingredientsCache.clear()
    data?.forEach((ing) => {
      // Apply overrides if branch is selected
      const overrideKey = `ingredient:${ing.id}`
      const override = this.overridesCache.get(overrideKey)

      const item: MenuIngredient = {
        ...ing,
        // Preserve legacy price for compatibility
        price: (override?.price_override ?? ing.price ?? ing.pickup_price ?? ing.delivery_price ?? 0) as number,
        // Dual pricing for add-ons
        pickup_price: (override?.price_override ?? ing.pickup_price ?? ing.price ?? 0) as number,
        delivery_price: (override?.price_override ?? ing.delivery_price ?? ing.price ?? 0) as number,
        is_available: (override?.availability_override ?? ing.is_available) as boolean,
        hasOverride: !!override,
        originalPrice: ing.price,
        originalAvailability: ing.is_available,
      }

      this.ingredientsCache.set(ing.id, item)
    })
  }

  /**
   * Load branch-specific overrides
   */
  private async loadOverrides(): Promise<void> {
    if (!this.branchId) {
      this.overridesCache.clear()
      return
    }

    const { data, error } = await supabase
      .from('menu_synchronization')
      .select('*')
      .eq('branch_id', this.branchId)
      .eq('app_name', 'pos-system')

    if (error) throw error

    this.overridesCache.clear()
    data?.forEach((override: BranchOverride) => {
      const resourceId = override.subcategory_id || override.ingredient_id || override.product_id
      if (resourceId && override.resource_type) {
        const key = `${override.resource_type}:${resourceId}`
        this.overridesCache.set(key, override)
      }
    })
  }

  /**
   * Refresh cache from database
   */
  async refreshCache(): Promise<void> {
    this.initialized = false
    await this.initialize()
  }

  /**
   * Get all categories
   */
  getCategories(): MenuCategory[] {
    return Array.from(this.categoriesCache.values())
  }

  /**
   * Get subcategories (menu items) filtered by category
   */
  getSubcategories(categoryId?: string): MenuSubcategory[] {
    const items = Array.from(this.subcategoriesCache.values())

    if (categoryId) {
      return items.filter((item) => item.category_id === categoryId)
    }

    return items
  }

  /**
   * Get ingredients filtered by category
   */
  getIngredients(categoryId?: string): MenuIngredient[] {
    const items = Array.from(this.ingredientsCache.values())

    if (categoryId) {
      return items.filter((item) => item.category_id === categoryId)
    }

    return items
  }

  /**
   * Check if menu item (subcategory) is available for current branch
   */
  isItemAvailable(subcategoryId: string): boolean {
    const item = this.subcategoriesCache.get(subcategoryId)
    return item?.is_available ?? false
  }

  /**
   * Check if ingredient is available for current branch
   */
  isIngredientAvailable(ingredientId: string): boolean {
    const ingredient = this.ingredientsCache.get(ingredientId)
    return ingredient?.is_available ?? false
  }

  /**
   * Get effective price for menu item (with override applied)
   */
  getItemPrice(subcategoryId: string, orderType?: 'pickup' | 'delivery'): number {
    const item = this.subcategoriesCache.get(subcategoryId)
    if (!item) return 0
    if (orderType === 'pickup' && typeof item.pickup_price === 'number') return item.pickup_price
    if (orderType === 'delivery' && typeof item.delivery_price === 'number') return item.delivery_price
    return item.price ?? 0
  }

  /**
   * Get effective price for ingredient (with override applied)
   */
  getIngredientPrice(ingredientId: string, orderType?: 'pickup' | 'delivery'): number {
    const ingredient = this.ingredientsCache.get(ingredientId)
    if (!ingredient) return 0
    if (orderType === 'pickup' && typeof ingredient.pickup_price === 'number') return ingredient.pickup_price
    if (orderType === 'delivery' && typeof ingredient.delivery_price === 'number') return ingredient.delivery_price
    return ingredient.price ?? 0
  }

  /**
   * Get single menu item by ID
   */
  getSubcategory(subcategoryId: string): MenuSubcategory | undefined {
    return this.subcategoriesCache.get(subcategoryId)
  }

  /**
   * Get single ingredient by ID
   */
  getIngredient(ingredientId: string): MenuIngredient | undefined {
    return this.ingredientsCache.get(ingredientId)
  }

  /**
   * Update branch ID and reload data
   */
  async setBranchId(branchId: string | null): Promise<void> {
    this.branchId = branchId
    await this.refreshCache()
  }

  /**
   * Save cache to localStorage for offline access
   */
  private saveToLocalStorage(): void {
    if (!this.branchId) return

    try {
      const cacheData = {
        branchId: this.branchId,
        timestamp: new Date().toISOString(),
        categories: Array.from(this.categoriesCache.entries()),
        subcategories: Array.from(this.subcategoriesCache.entries()),
        ingredients: Array.from(this.ingredientsCache.entries()),
        overrides: Array.from(this.overridesCache.entries()),
      }

      localStorage.setItem(
        `branch_menu_cache_${this.branchId}`,
        JSON.stringify(cacheData)
      )
    } catch (error) {
      console.error('Error saving to localStorage:', error)
    }
  }

  /**
   * Load cache from localStorage for offline access
   */
  private loadFromLocalStorage(): void {
    if (!this.branchId) return

    try {
      const cached = localStorage.getItem(`branch_menu_cache_${this.branchId}`)
      if (!cached) return

      const cacheData = JSON.parse(cached)
      const cacheAge = Date.now() - new Date(cacheData.timestamp).getTime()

      // Use cache if less than 1 hour old
      if (cacheAge < 60 * 60 * 1000) {
        this.categoriesCache = new Map(cacheData.categories)
        this.subcategoriesCache = new Map(cacheData.subcategories)
        this.ingredientsCache = new Map(cacheData.ingredients)
        this.overridesCache = new Map(cacheData.overrides)
      }
    } catch (error) {
      console.error('Error loading from localStorage:', error)
    }
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.categoriesCache.clear()
    this.subcategoriesCache.clear()
    this.ingredientsCache.clear()
    this.overridesCache.clear()
    this.initialized = false

    if (this.branchId) {
      try {
        localStorage.removeItem(`branch_menu_cache_${this.branchId}`)
      } catch (error) {
        console.error('Error clearing localStorage:', error)
      }
    }
  }
}
