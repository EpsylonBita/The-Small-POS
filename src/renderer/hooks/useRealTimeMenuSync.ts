import { useEffect, useRef, useState, useCallback } from 'react'
import { getSupabaseClient } from '../../shared/supabase-config'
import { RealtimeChannel } from '@supabase/supabase-js'
import { subscriptionManager } from '../services/SubscriptionManager'
import { emitCompatEvent, getBridge } from '../../lib'

interface MenuSyncState {
  isConnected: boolean
  lastUpdate: string | null
  errors: string[]
  syncCount: number
}

interface MenuUpdatePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new?: any
  old?: any
  table: string
}

interface UseRealTimeMenuSyncOptions {
  branchId?: string | null
  terminalId?: string | null
  onMenuUpdate?: (payload: MenuUpdatePayload) => void
}

function isPosAppName(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const normalized = value.trim().toLowerCase()
  return normalized === 'pos-tauri' || normalized === 'pos-system'
}

/**
 * Real-time menu synchronization hook for POS system
 * Listens for menu changes from admin dashboard and updates local data
 * Supports branch-specific menu overrides
 */
export function useRealTimeMenuSync(options?: UseRealTimeMenuSyncOptions) {
  const { branchId, terminalId, onMenuUpdate } = options || {}

  const [state, setState] = useState<MenuSyncState>({
    isConnected: false,
    lastUpdate: null,
    errors: [],
    syncCount: 0
  })

  const supabaseRef = useRef(getSupabaseClient())
  const channelsRef = useRef<Map<string, RealtimeChannel>>(new Map())
  const overridesRef = useRef<Map<string, any>>(new Map())

  const overrideUnsubRef = useRef<null | (() => void)>(null)

  const notifyMenuUpdate = useCallback((payload: Record<string, unknown>) => {
    try {
      emitCompatEvent('menu:sync', payload)
    } catch (error) {
      console.debug('Menu update bridge emit failed:', error)
    }
  }, [])

  // Handle branch-specific menu synchronization overrides
  const handleMenuSyncOverride = useCallback((payload: any) => {
    const row = payload?.new || payload?.old
    if (!row) return

    // Guard: Only process POS overrides
    if (!isPosAppName(row.app_name)) return

    // Use correct column names: subcategory_id, ingredient_id, product_id
    const resourceId = String(row.subcategory_id || row.ingredient_id || row.product_id || '')
    if (!resourceId) return

    // Store with resource type prefix for proper identification
    const resourceType = row.resource_type || 'subcategory'
    const key = `${resourceType}:${resourceId}`

    if (payload.eventType === 'DELETE') {
      overridesRef.current.delete(key)
      overridesRef.current.delete(resourceId) // Also delete non-prefixed for backward compatibility
    } else {
      overridesRef.current.set(key, row)
      overridesRef.current.set(resourceId, row) // Also store non-prefixed for backward compatibility
    }

    // Also notify consumers that override changed
    const updatePayload: MenuUpdatePayload = {
      eventType: payload.eventType,
      new: row,
      old: payload.old,
      table: 'menu_synchronization'
    }

    notifyMenuUpdate({ ...updatePayload, branchId: row.branch_id })
  }, [notifyMenuUpdate])

  const mountedRef = useRef(true)

  // Handle menu updates
  const handleMenuUpdate = useCallback((table: string, payload: any) => {
    if (!mountedRef.current) return

    // Apply branch overrides if available (for subcategories/items)
    // Only apply overrides that match the active branch
    let mergedNew = payload.new
    if ((table === 'subcategories' || table === 'ingredients') && mergedNew?.id && branchId) {
      // Try with resource type prefix first
      const resourceType = table === 'subcategories' ? 'subcategory' : 'ingredient'
      const prefixedKey = `${resourceType}:${mergedNew.id}`
      const ov = overridesRef.current.get(prefixedKey) || overridesRef.current.get(String(mergedNew.id))

      // Verify override belongs to the active branch AND is for POS system
      if (ov && ov.branch_id === branchId && isPosAppName(ov.app_name)) {
        mergedNew = { ...mergedNew }
        if (typeof ov.price_override === 'number') mergedNew.price = ov.price_override
        if (typeof ov.availability_override === 'boolean') mergedNew.is_available = ov.availability_override
      }
    }

    const updatePayload: MenuUpdatePayload = {
      eventType: payload.eventType,
      new: mergedNew,
      old: payload.old,
      table
    }

    setState(prev => ({
      ...prev,
      lastUpdate: new Date().toISOString(),
      syncCount: prev.syncCount + 1
    }))

    // Call the callback if provided
    onMenuUpdate?.(updatePayload)

    // Enhanced structured logging for POS system
    console.log(`🔄 POS Menu sync: ${table} ${payload.eventType}`, {
      ...updatePayload,
      timestamp: new Date().toISOString(),
      recordId: payload.new?.id || payload.old?.id,
      recordName: payload.new?.name || payload.old?.name,
      syncCount: state.syncCount + 1
    })

    notifyMenuUpdate({ ...updatePayload, branchId: (updatePayload.new?.branch_id || null) })
  }, [onMenuUpdate])

  // Handle connection errors
  const handleError = useCallback((table: string, error: any) => {
    if (!mountedRef.current) return

    const errorMessage = `${table}: ${error.message || 'Connection error'}`

    setState(prev => ({
      ...prev,
      errors: [...prev.errors.slice(-4), errorMessage], // Keep last 5 errors
      isConnected: false
    }))

    console.error(`❌ POS Menu sync error for ${table}:`, error)
  }, [])

  // Setup real-time subscriptions
  const setupSubscriptions = useCallback(() => {
    if (!mountedRef.current) return

    // DISABLED: Real-time subscriptions are now handled by the main process (sync-service)
    // to prevent multiple WebSocket connections which cause connection failures.
    // The main process forwards updates to the renderer via IPC events.
    console.log('📡 [useRealTimeMenuSync] Real-time subscriptions disabled - using main process IPC instead');

    // Clean up existing channels
    channelsRef.current.forEach((channel) => {
      supabaseRef.current.removeChannel(channel)
    })
    channelsRef.current.clear()

    // Mark as connected (even though we're not subscribing) to prevent UI errors
    setState(prev => ({
      ...prev,
      isConnected: true
    }))

    // Preload existing overrides once (filtered by branch) even without WS subscriptions
    overridesRef.current.clear()
    if (branchId) {
      ;(async () => {
        try {
          let query = supabaseRef.current
            .from('menu_synchronization')
            .select('*')
            .eq('branch_id', branchId)
            .in('app_name', ['pos-tauri', 'pos-system'])

          const { data, error } = await query
          if (!error && Array.isArray(data)) {
            data.forEach((row: any) => {
              const resourceId = String(row.subcategory_id || row.ingredient_id || row.product_id || '')
              if (resourceId) {
                const resourceType = row.resource_type || 'subcategory'
                const key = `${resourceType}:${resourceId}`
                overridesRef.current.set(key, row)
                overridesRef.current.set(resourceId, row) // backward compatibility
              }
            })
            // Signal downstream consumers that overrides changed
            setState(prev => ({ ...prev, lastUpdate: new Date().toISOString() }))
          }
        } catch (e) {
          console.warn('Failed to preload menu overrides', e)
        }
      })()
    }


    // Exit early - no subscriptions created
    // All code below is commented out to prevent WebSocket connections

    /* DISABLED - All real-time subscriptions handled by main process
    // Tables to monitor for menu changes
    // Note: 'categories' table does not exist - removed from list
    const menuTables = [
      'menu_categories',
      'subcategories',
      'ingredients',
      'ingredient_categories'
    ]

      // Manage branch-specific overrides subscription via subscriptionManager
      if (overrideUnsubRef.current) {
        try { overrideUnsubRef.current() } catch {}
        overrideUnsubRef.current = null
      }

      // Only subscribe to overrides if branchId is available
      if (branchId) {
        overrideUnsubRef.current = subscriptionManager.subscribe('menu_synchronization', {
          table: 'menu_synchronization',
          event: '*',
          filter: `branch_id=eq.${branchId}&app_name=eq.pos-tauri`,
          callback: (pl) => handleMenuSyncOverride(pl)
        })

        // Preload existing overrides once on connect (filtered by branch)
        overridesRef.current.clear()
        ;(async () => {
          try {
            let query = supabaseRef.current
              .from('menu_synchronization')
              .select('*')
              .eq('branch_id', branchId)

            // Optionally filter by app_name
            query = query.eq('app_name', 'pos-tauri')

            const { data, error } = await query
            if (!error && Array.isArray(data)) {
              data.forEach((row: any) => {
                // Use correct column names: subcategory_id, ingredient_id, product_id
                const resourceId = String(row.subcategory_id || row.ingredient_id || row.product_id || '')
                if (resourceId) {
                  // Store with resource type prefix for uniqueness
                  const resourceType = row.resource_type || 'subcategory'
                  const key = `${resourceType}:${resourceId}`
                  overridesRef.current.set(key, row)
                  overridesRef.current.set(resourceId, row) // Also store without prefix for backward compatibility
                }
              })
            }
          } catch (e) {
            console.warn('Failed to preload menu overrides', e)
          }
        })()
      }

    menuTables.forEach((table) => {
      const channelName = `pos_menu_sync_${table}_${Date.now()}`

      const channel = supabaseRef.current
        .channel(channelName)

        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table
          },
          (payload) => handleMenuUpdate(table, payload)
        )
        .subscribe((status) => {
          if (!mountedRef.current) return

          if (status === 'SUBSCRIBED') {
            console.log(`✅ POS subscribed to ${table} updates`)
            setState(prev => ({
              ...prev,
              isConnected: true
            }))
          } else if (status === 'CHANNEL_ERROR') {
            handleError(table, { message: 'Channel error' })
          } else if (status === 'TIMED_OUT') {
            handleError(table, { message: 'Connection timeout' })
          } else if (status === 'CLOSED') {
            console.log(`🔌 POS menu sync closed for ${table}`)
            setState(prev => ({
              ...prev,
              isConnected: false
            }))
          }
        })

      channelsRef.current.set(table, channel)
    })
    */
  }, [handleMenuUpdate, handleError])

  // Cleanup function
  const cleanup = useCallback(() => {
    channelsRef.current.forEach((channel) => {
      supabaseRef.current.removeChannel(channel)
    })
    channelsRef.current.clear()

    setState(prev => ({
      ...prev,
      isConnected: false
    }))
    // Clear overrides on cleanup
    overridesRef.current.clear()
    // Unsubscribe override listener
    if (overrideUnsubRef.current) {
      try { overrideUnsubRef.current() } catch {}
      overrideUnsubRef.current = null
    }
  }, [])

  // Reconnect function
  const reconnect = useCallback(() => {
    cleanup()
    setTimeout(() => {
      if (mountedRef.current) {
        setupSubscriptions()
      }
    }, 1000)
  }, [cleanup, setupSubscriptions])

  // Clear errors
  const clearErrors = useCallback(() => {
    setState(prev => ({
      ...prev,
      errors: []
    }))
  }, [])

  // Setup subscriptions on mount
  useEffect(() => {
    setupSubscriptions()

    return () => {
      mountedRef.current = false
      cleanup()
    }
  }, [setupSubscriptions, cleanup])

  /**
   * Get effective menu item with overrides applied
   */
  const getEffectiveMenuItem = useCallback((menuItem: any) => {
    if (!branchId || !menuItem?.id) return menuItem

    const resourceType = 'subcategory'
    const prefixedKey = `${resourceType}:${menuItem.id}`
    const override = overridesRef.current.get(prefixedKey) || overridesRef.current.get(String(menuItem.id))

    if (!override || override.branch_id !== branchId) return menuItem

    return {
      ...menuItem,
      price: override.price_override ?? menuItem.price,
      is_available: override.availability_override ?? menuItem.is_available,
      hasOverride: true,
      originalPrice: menuItem.price,
      originalAvailability: menuItem.is_available
    }
  }, [branchId])

  /**
   * Get effective ingredient with overrides applied
   */
  const getEffectiveIngredient = useCallback((ingredient: any) => {
    if (!branchId || !ingredient?.id) return ingredient

    const resourceType = 'ingredient'
    const prefixedKey = `${resourceType}:${ingredient.id}`
    const override = overridesRef.current.get(prefixedKey) || overridesRef.current.get(String(ingredient.id))

    if (!override || override.branch_id !== branchId) return ingredient

    return {
      ...ingredient,
      price: override.price_override ?? ingredient.price,
      is_available: override.availability_override ?? ingredient.is_available,
      hasOverride: true,
      originalPrice: ingredient.price,
      originalAvailability: ingredient.is_available
    }
  }, [branchId])

  /**
   * Get current overrides Map
   */
  const getCurrentOverrides = useCallback(() => {
    return overridesRef.current
  }, [])

  return {
    isConnected: state.isConnected,
    lastUpdate: state.lastUpdate,
    errors: state.errors,
    syncCount: state.syncCount,
    reconnect,
    clearErrors,
    getEffectiveMenuItem,
    getEffectiveIngredient,
    getCurrentOverrides,
    overridesRef // Export for advanced use cases
  }
}

/**
 * Hook for handling specific menu data updates in POS components
 */
export function useMenuDataSync() {
  const [menuData, setMenuData] = useState({
    categories: [] as any[],
    subcategories: [] as any[],
    ingredients: [] as any[],
    lastSync: null as string | null
  })

  const handleMenuUpdate = useCallback((payload: MenuUpdatePayload) => {
    const { table, eventType, new: newData, old: oldData } = payload

    setMenuData(prev => {
      const updated = { ...prev, lastSync: new Date().toISOString() }

      switch (table) {
        case 'menu_categories':
          if (eventType === 'INSERT' && newData) {
            updated.categories = [...prev.categories, newData]
          } else if (eventType === 'UPDATE' && newData) {
            updated.categories = prev.categories.map((item: any) =>
              item.id === newData.id ? newData : item
            )
          } else if (eventType === 'DELETE' && oldData) {
            updated.categories = prev.categories.filter((item: any) =>
              item.id !== oldData.id
            )
          }
          break

        case 'subcategories':
          if (eventType === 'INSERT' && newData) {
            updated.subcategories = [...prev.subcategories, newData]
          } else if (eventType === 'UPDATE' && newData) {
            updated.subcategories = prev.subcategories.map((item: any) =>
              item.id === newData.id ? newData : item
            )
          } else if (eventType === 'DELETE' && oldData) {
            updated.subcategories = prev.subcategories.filter((item: any) =>
              item.id !== oldData.id
            )
          }
          break

        case 'ingredients':
          if (eventType === 'INSERT' && newData) {
            updated.ingredients = [...prev.ingredients, newData]
          } else if (eventType === 'UPDATE' && newData) {
            updated.ingredients = prev.ingredients.map((item: any) =>
              item.id === newData.id ? newData : item
            )
          } else if (eventType === 'DELETE' && oldData) {
            updated.ingredients = prev.ingredients.filter((item: any) =>
              item.id !== oldData.id
            )
          }
          break
      }

      return updated
    })

    // Show notification in native runtimes (no-op in browser stub).
    void getBridge().notifications
      .show({
        title: 'Menu Updated',
        body: `${table} ${eventType.toLowerCase()}d from admin dashboard`,
        icon: 'info'
      })
      .catch((error: unknown) => {
        console.debug('Native notification API not available:', error)
      })
  }, [])

  const syncState = useRealTimeMenuSync({ onMenuUpdate: handleMenuUpdate })

  return {
    ...syncState,
    menuData,
    setMenuData
  }
}

