import { useState, useEffect, useRef, useCallback } from 'react'
import { BranchMenuFilterService } from '../../services/BranchMenuFilterService'
import { useRealTimeMenuSync } from './useRealTimeMenuSync'
import { offEvent, onEvent } from '../../lib'

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
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoRefreshAtRef = useRef<number>(0)

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

  const refreshFromCache = useCallback(
    async (force = false) => {
      if (!serviceRef.current) return
      if (!force && autoRefresh && refreshInterval > 0) {
        const now = Date.now()
        if (now - lastAutoRefreshAtRef.current < refreshInterval) {
          return
        }
        lastAutoRefreshAtRef.current = now
      }

      await serviceRef.current.refreshCache()
      setCategories(serviceRef.current.getCategories())
      setSubcategories(serviceRef.current.getSubcategories())
      setIngredients(serviceRef.current.getIngredients())
    },
    [autoRefresh, refreshInterval]
  )

  const scheduleRefresh = useCallback(
    (delayMs = 250, force = false) => {
      if (pendingRefreshRef.current) return
      pendingRefreshRef.current = setTimeout(() => {
        pendingRefreshRef.current = null
        void refreshFromCache(force).catch((err) => {
          console.error('Error refreshing branch menu cache:', err)
        })
      }, delayMs)
    },
    [refreshFromCache]
  )

  // Initial load
  useEffect(() => {
    loadData()
  }, [loadData])

  // Auto-refresh without timers: use sync events with refresh-interval throttling.
  useEffect(() => {
    if (!autoRefresh || refreshInterval <= 0) return

    const handleSyncStatus = () => {
      scheduleRefresh(300, false)
    }
    const handleSyncComplete = () => {
      scheduleRefresh(200, false)
    }

    onEvent('sync:status', handleSyncStatus)
    onEvent('sync:complete', handleSyncComplete)

    return () => {
      offEvent('sync:status', handleSyncStatus)
      offEvent('sync:complete', handleSyncComplete)
    }
  }, [autoRefresh, refreshInterval, scheduleRefresh])

  // React to explicit menu sync events from the backend.
  useEffect(() => {
    const handleMenuSync = () => {
      scheduleRefresh(250, true)
    }
    onEvent('menu:sync', handleMenuSync)
    return () => {
      offEvent('menu:sync', handleMenuSync)
    }
  }, [scheduleRefresh])

  // Listen for real-time menu updates
  useEffect(() => {
    if (menuSync.lastUpdate && serviceRef.current) {
      // Debounce refresh to avoid too many updates.
      scheduleRefresh(500, true)
    }
  }, [menuSync.lastUpdate, scheduleRefresh])

  useEffect(() => {
    return () => {
      if (pendingRefreshRef.current) {
        clearTimeout(pendingRefreshRef.current)
      }
    }
  }, [])

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
