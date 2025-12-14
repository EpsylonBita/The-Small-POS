import { useState, useEffect, useRef, useCallback } from 'react'
import { BranchMenuFilterService } from '../../services/BranchMenuFilterService'
import { useRealTimeMenuSync } from './useRealTimeMenuSync'

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
  price: number
  base_price?: number
  is_available: boolean
  display_order: number
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
  price: number
  cost: number
  stock_quantity: number
  is_available: boolean
  hasOverride?: boolean
  originalPrice?: number
  originalAvailability?: boolean
}

interface UseBranchMenuOptions {
  autoRefresh?: boolean
  refreshInterval?: number
}

interface UseBranchMenuReturn {
  categories: MenuCategory[]
  subcategories: MenuSubcategory[]
  ingredients: MenuIngredient[]
  isLoading: boolean
  error: string | null
  isItemAvailable: (id: string) => boolean
  isIngredientAvailable: (id: string) => boolean
  getItemPrice: (id: string, orderType?: 'pickup' | 'delivery') => number
  getIngredientPrice: (id: string, orderType?: 'pickup' | 'delivery') => number
  refresh: () => Promise<void>
}

/**
 * Hook to consume BranchMenuFilterService with real-time updates
 * Provides easy access to branch-filtered menu data in POS system
 */
export function useBranchMenu(
  branchId: string | null,
  options?: UseBranchMenuOptions
): UseBranchMenuReturn {
  const { autoRefresh = true, refreshInterval = 300000 } = options || {} // 5 minutes default

  const [categories, setCategories] = useState<MenuCategory[]>([])
  const [subcategories, setSubcategories] = useState<MenuSubcategory[]>([])
  const [ingredients, setIngredients] = useState<MenuIngredient[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const serviceRef = useRef<BranchMenuFilterService | null>(null)
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Use real-time menu sync to get updates
  const menuSync = useRealTimeMenuSync({ branchId })

  // Initialize service
  useEffect(() => {
    if (!serviceRef.current || serviceRef.current['branchId'] !== branchId) {
      serviceRef.current = new BranchMenuFilterService(branchId)
    }
  }, [branchId])

  // Load menu data
  const loadData = useCallback(async () => {
    if (!serviceRef.current) return

    setIsLoading(true)
    setError(null)

    try {
      await serviceRef.current.initialize()

      setCategories(serviceRef.current.getCategories())
      setSubcategories(serviceRef.current.getSubcategories())
      setIngredients(serviceRef.current.getIngredients())
    } catch (err) {
      console.error('Error loading branch menu:', err)
      setError(err instanceof Error ? err.message : 'Failed to load menu data')
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    loadData()
  }, [loadData])

  // Set up auto-refresh
  useEffect(() => {
    if (!autoRefresh || refreshInterval <= 0) return

    refreshTimerRef.current = setInterval(() => {
      if (serviceRef.current) {
        serviceRef.current.refreshCache().then(() => {
          setCategories(serviceRef.current!.getCategories())
          setSubcategories(serviceRef.current!.getSubcategories())
          setIngredients(serviceRef.current!.getIngredients())
        })
      }
    }, refreshInterval)

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current)
      }
    }
  }, [autoRefresh, refreshInterval])

  // Listen for real-time menu updates
  useEffect(() => {
    if (menuSync.lastUpdate && serviceRef.current) {
      // Debounce refresh to avoid too many updates
      const timeoutId = setTimeout(() => {
        serviceRef.current?.refreshCache().then(() => {
          setCategories(serviceRef.current!.getCategories())
          setSubcategories(serviceRef.current!.getSubcategories())
          setIngredients(serviceRef.current!.getIngredients())
        })
      }, 500)

      return () => clearTimeout(timeoutId)
    }
  }, [menuSync.lastUpdate])

  // Memoized helper functions
  const isItemAvailable = useCallback(
    (id: string): boolean => {
      return serviceRef.current?.isItemAvailable(id) ?? false
    },
    [serviceRef.current]
  )

  const isIngredientAvailable = useCallback(
    (id: string): boolean => {
      return serviceRef.current?.isIngredientAvailable(id) ?? false
    },
    [serviceRef.current]
  )

  const getItemPrice = useCallback(
    (id: string, orderType?: 'pickup' | 'delivery'): number => {
      return serviceRef.current?.getItemPrice(id, orderType) ?? 0
    },
    [serviceRef.current]
  )

  const getIngredientPrice = useCallback(
    (id: string, orderType?: 'pickup' | 'delivery'): number => {
      return serviceRef.current?.getIngredientPrice(id, orderType) ?? 0
    },
    [serviceRef.current]
  )

  const refresh = useCallback(async () => {
    await loadData()
  }, [loadData])

  return {
    categories,
    subcategories,
    ingredients,
    isLoading,
    error,
    isItemAvailable,
    isIngredientAvailable,
    getItemPrice,
    getIngredientPrice,
    refresh,
  }
}
