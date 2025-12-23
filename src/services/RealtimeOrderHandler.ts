import type { BrowserWindow } from 'electron'
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js'
import { getSupabaseClient } from '../shared/supabase-config'
import type { DatabaseManager } from '../main/database'

/**
 * OrderItem interface for local storage format
 */
export interface OrderItem {
  id: string;
  menu_item_id?: string;
  name: string;
  quantity: number;
  price: number;
  unit_price: number;
  total_price: number;
  notes?: string;
  customizations?: any;
}

/**
 * Supabase order_items response with nested subcategories
 */
interface SupabaseOrderItemResponse {
  id: string;
  menu_item_id: string | null;
  quantity: number;
  unit_price: number | string;
  total_price: number | string;
  notes?: string;
  customizations?: any;
  subcategories?: {
    id: string;
    name: string;
    name_en?: string;
    name_el?: string;
  } | {
    id: string;
    name: string;
    name_en?: string;
    name_el?: string;
  }[] | null;
}

/**
 * RealtimeOrderHandler
 * Subscribes to Supabase real-time changes for orders and forwards events to renderer.
 * Designed to run in Electron main process.
 */
export class RealtimeOrderHandler {
  private branchId: string | null
  private terminalId: string
  private mainWindow: BrowserWindow | null
  private dbManager: DatabaseManager
  private channels: RealtimeChannel[] = []
  private client: SupabaseClient<any, 'public', any>
  // Resubscribe/backoff state
  private ordersChannel: RealtimeChannel | null = null
  private itemsChannel: RealtimeChannel | null = null
  private retryAttempts = 0
  private resubscribeTimer?: NodeJS.Timeout
  private readonly maxBackoffMs = 10000

  constructor(
    branchId: string | null,
    terminalId: string,
    mainWindow: BrowserWindow | null,
    dbManager: DatabaseManager
  ) {
    this.branchId = branchId
    this.terminalId = terminalId
    this.mainWindow = mainWindow
    this.dbManager = dbManager
    this.client = getSupabaseClient()
  }

  /**
   * Fetches order items from Supabase with nested subcategories select.
   * Transforms Supabase response to local OrderItem format.
   * Resolves menu_item_id to subcategory names for display.
   * 
   * @param orderId - The Supabase order ID to fetch items for
   * @returns Array of OrderItem objects in local format
   * 
   * Requirements: 1.1, 1.2, 1.4
   */
  async fetchOrderItemsFromSupabase(orderId: string): Promise<OrderItem[]> {
    try {
      console.log(`[RealtimeOrderHandler] Fetching order items for order ${orderId}`)
      
      // Fetch order_items with nested subcategories select
      const { data: items, error } = await this.client
        .from('order_items')
        .select(`
          id,
          menu_item_id,
          quantity,
          unit_price,
          total_price,
          notes,
          customizations,
          subcategories (
            id,
            name,
            name_en,
            name_el
          )
        `)
        .eq('order_id', orderId)
      
      if (error) {
        console.error(`[RealtimeOrderHandler] Error fetching order items for ${orderId}:`, error)
        return []
      }
      
      if (!items || items.length === 0) {
        console.log(`[RealtimeOrderHandler] No items found for order ${orderId}`)
        return []
      }
      
      // Transform Supabase response to local OrderItem format
      const transformedItems = this.transformOrderItems(items as SupabaseOrderItemResponse[], orderId)
      
      console.log(`[RealtimeOrderHandler] Fetched and transformed ${transformedItems.length} items for order ${orderId}`)
      return transformedItems
    } catch (e) {
      console.error(`[RealtimeOrderHandler] Failed to fetch order items for ${orderId}:`, e)
      return []
    }
  }

  /**
   * Transforms Supabase order_items response to local OrderItem format.
   * Resolves menu_item_id to subcategory names.
   * 
   * @param items - Array of Supabase order_items with nested subcategories
   * @param _orderId - The order ID for logging purposes (unused but kept for future debugging)
   * @returns Array of OrderItem objects in local format
   * 
   * Requirements: 1.4
   */
  private transformOrderItems(items: SupabaseOrderItemResponse[], _orderId: string): OrderItem[] {
    return items.map((item, index) => {
      // Resolve name from subcategories (menu_item_id references subcategories.id)
      let itemName: string = ''
      
      // First try to get name from nested subcategories
      if (item.subcategories) {
        // Handle both single object and array formats from Supabase
        const subcategory = Array.isArray(item.subcategories) ? item.subcategories[0] : item.subcategories
        if (subcategory) {
          itemName = subcategory.name || subcategory.name_en || subcategory.name_el || ''
        }
      }
      
      // If no name from subcategories, try to extract from customizations
      if (!itemName) {
        itemName = this.extractNameFromCustomizations(item.customizations)
      }
      
      // Fallback to generic name with price
      if (!itemName) {
        const price = parseFloat(String(item.unit_price)) || 0
        itemName = `Item ${index + 1} (€${price.toFixed(2)})`
      }
      
      const unitPrice = parseFloat(String(item.unit_price)) || 0
      const quantity = item.quantity || 1
      const totalPrice = parseFloat(String(item.total_price)) || (unitPrice * quantity)
      
      return {
        id: item.id,
        menu_item_id: item.menu_item_id || undefined,
        name: itemName,
        quantity: quantity,
        price: unitPrice,
        unit_price: unitPrice,
        total_price: totalPrice,
        notes: item.notes,
        customizations: item.customizations
      }
    })
  }

  /**
   * Extracts item name from customizations object.
   * Customizations may contain ingredient names that can be used as fallback.
   * 
   * @param customizations - The customizations object from order_items
   * @returns The extracted name or empty string
   */
  private extractNameFromCustomizations(customizations: any): string {
    if (!customizations || typeof customizations !== 'object') return ''
    
    // Handle array format
    if (Array.isArray(customizations)) {
      for (const cust of customizations) {
        if (cust?.ingredient?.name) return cust.ingredient.name
        if (cust?.name) return cust.name
      }
      return ''
    }
    
    // Handle object format
    for (const key of Object.keys(customizations)) {
      const cust = customizations[key]
      if (cust?.ingredient?.name) return cust.ingredient.name
      if (cust?.name) return cust.name
    }
    return ''
  }

  async initialize(): Promise<void> {
    console.log('🚀 [RealtimeOrderHandler] Initializing...', {
      branchId: this.branchId,
      terminalId: this.terminalId
    })

    this.subscribeOrdersChannel()
    this.subscribeItemsChannel()
  }

  private subscribeOrdersChannel() {
    // Clean any existing
    if (this.ordersChannel) {
      try { this.client.removeChannel(this.ordersChannel) } catch { /* noop */ }
      this.ordersChannel = null
    }

    const channelName = `orders_rt_${this.terminalId}_${Date.now()}`
    const ch = this.client
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          ...(this.branchId ? { filter: `branch_id=eq.${this.branchId}` } : {}),
        } as any,
        (payload: any) => this.handleOrderChange(payload)
      )
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          this.retryAttempts = 0
          this.clearResubscribe()
          console.log('[RealtimeOrderHandler] Orders channel subscribed')
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.scheduleResubscribe('orders')
        }
      })

    this.ordersChannel = ch
    this.channels.push(ch)
  }

  private subscribeItemsChannel() {
    if (this.itemsChannel) {
      try { this.client.removeChannel(this.itemsChannel) } catch { /* noop */ }
      this.itemsChannel = null
    }

    const channelName = `order_items_rt_${this.terminalId}_${Date.now()}`
    const ch = this.client
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'order_items',
        } as any,
        (payload: any) => this.handleOrderItemChange(payload)
      )
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          this.retryAttempts = 0
          this.clearResubscribe()
          console.log('[RealtimeOrderHandler] Order items channel subscribed')
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.scheduleResubscribe('items')
        }
      })

    this.itemsChannel = ch
    this.channels.push(ch)
  }

  private scheduleResubscribe(kind: 'orders'|'items') {
    this.clearResubscribe()
    const delay = Math.min(this.maxBackoffMs, 1000 * Math.pow(2, this.retryAttempts))
    this.retryAttempts++
    console.warn(`[RealtimeOrderHandler] ${kind} channel issue. Resubscribing in ${delay}ms (attempt ${this.retryAttempts})`)
    this.resubscribeTimer = setTimeout(() => {
      if (kind === 'orders') this.subscribeOrdersChannel(); else this.subscribeItemsChannel();
    }, delay)
  }

  private clearResubscribe() {
    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer)
      this.resubscribeTimer = undefined
    }
  }

  async cleanup(): Promise<void> {
    try {
      this.clearResubscribe()
      for (const ch of this.channels) {
        try {
          this.client.removeChannel(ch)
        } catch (e) {
          // ignore
        }
      }
    } finally {
      this.channels = []
      this.ordersChannel = null
      this.itemsChannel = null
      this.retryAttempts = 0
    }
  }

  private async handleOrderChange(payload: any) {
    // Supabase realtime uses 'eventType' property
    const eventType = payload.eventType || payload.event
    const order = payload.new || payload.old

    console.log('📡 [RealtimeOrderHandler] Order change detected:', {
      eventType,
      orderId: order?.id,
      branchId: this.branchId,
      terminalId: this.terminalId,
      originTerminalId: payload?.new?.origin_terminal_id
    })

    // Ignore events originated by this terminal if present
    if (payload?.new?.origin_terminal_id && payload.new.origin_terminal_id === this.terminalId) {
      console.log('📡 [RealtimeOrderHandler] Ignoring event from same terminal')
      return
    }

    // Sync to local DB with optimistic locking
    if (order) {
      try {
        await this.syncToLocalDB(order, eventType)
      } catch (error) {
        console.error('[RealtimeOrderHandler] Failed to sync order to local DB:', error)
        // Emit conflict event if version mismatch
        if ((error as any).message?.includes('version')) {
          this.emitToRenderer('order-sync-conflict', {
            orderId: order.id,
            remoteVersion: order.version,
            error: (error as any).message
          })
        }
      }
    }

    // Map eventType to specific IPC events
    let ipcEvent = 'realtime-order-update'
    if (eventType === 'INSERT') {
      ipcEvent = 'order-created'
    } else if (eventType === 'UPDATE') {
      // Check if status changed
      if (payload.old?.status !== payload.new?.status) {
        ipcEvent = 'order-status-updated'
      } else {
        ipcEvent = 'order-updated'
      }
    } else if (eventType === 'DELETE') {
      ipcEvent = 'order-deleted'
    }

    console.log(`📡 [RealtimeOrderHandler] Emitting IPC event: ${ipcEvent}`, {
      orderId: payload.new?.id || payload.old?.id,
      eventType
    })

    // Forward to renderer with context (always include eventType)
    this.emitToRenderer(ipcEvent, {
      eventType: eventType,
      table: 'orders',
      branchId: this.branchId,
      terminalId: this.terminalId,
      new: payload.new,
      old: payload.old,
    })
  }

  /**
   * Sync order to local database with optimistic locking
   */
  private async syncToLocalDB(order: any, eventType: string): Promise<void> {
    const orderService = this.dbManager.getDatabaseService().orders
    const settingsService = this.dbManager.getDatabaseService().settings

    // Skip orders that have been closed/included in a Z report
    // These should NOT be synced back to local POS after Z report clears them
    if (order.is_closed === true || order.z_report_id) {
      console.log(`[RealtimeOrderHandler] Skipping closed/Z-reported order ${order.id} (is_closed=${order.is_closed}, z_report_id=${order.z_report_id})`)
      return
    }

    // Skip orders created BEFORE the last Z-Report timestamp
    // This prevents old orders from being synced back after Z-Report clears them
    // Even if is_closed wasn't set properly on the server, we use local timestamp as source of truth
    const lastZReportTimestamp = settingsService?.getSetting<string>('system', 'last_z_report_timestamp')
    if (lastZReportTimestamp && order.created_at) {
      const orderCreatedAt = new Date(order.created_at).getTime()
      const zReportTime = new Date(lastZReportTimestamp).getTime()
      if (orderCreatedAt <= zReportTime) {
        console.log(`[RealtimeOrderHandler] Skipping order ${order.id} created before Z-Report (order: ${order.created_at}, z-report: ${lastZReportTimestamp})`)
        return
      }
    }

    if (eventType === 'INSERT' || eventType === 'UPDATE') {
      // Check version for optimistic locking
      const existingOrder = orderService.getOrder(order.id)

      if (existingOrder) {
        const localVersion = existingOrder.version || 1
        const remoteVersion = order.version || 1

        if (remoteVersion < localVersion) {
          // Remote is older, skip
          console.warn(`[RealtimeOrderHandler] Remote order version ${remoteVersion} < local ${localVersion}, skipping`)
          return
        } else if (remoteVersion === localVersion && existingOrder.updated_at >= order.updated_at) {
          // Same version but local is newer, skip
          console.warn(`[RealtimeOrderHandler] Local order is newer, skipping`)
          return
        }
      }

      // Fetch order items from Supabase if not included in the order object
      // Requirements: 1.2, 1.3 - Check if incoming order has empty items array and fetch if missing
      let orderItems = order.items
      if (!orderItems || (Array.isArray(orderItems) && orderItems.length === 0)) {
        // Use the dedicated fetchOrderItemsFromSupabase function
        orderItems = await this.fetchOrderItemsFromSupabase(order.id)
      }

      // Create or update order with items
      const orderDataWithItems = {
        ...order,
        items: orderItems || [],
        sync_status: 'synced',
        last_synced_at: new Date().toISOString(),
        remote_version: order.version
      }

      const existing = orderService.getOrder(order.id)
      if (existing) {
        orderService.updateOrder(order.id, orderDataWithItems)
      } else {
        orderService.createOrder(orderDataWithItems)
      }
    } else if (eventType === 'DELETE') {
      // Mark as deleted or remove
      orderService.deleteOrder(order.id)
    }
  }

  private handleOrderItemChange(payload: any) {
    // Supabase realtime uses 'eventType' property
    const eventType = payload.eventType || payload.event

    this.emitToRenderer('realtime-order-item-update', {
      eventType: eventType,
      table: 'order_items',
      branchId: this.branchId,
      terminalId: this.terminalId,
      new: payload.new,
      old: payload.old,
    })
  }

  private emitToRenderer(channel: string, data: any) {
    try {
      // Validate data before sending
      if (!data || !data.eventType) {
        console.warn(`[RealtimeOrderHandler] Attempted to emit ${channel} with invalid data:`, data);
        return;
      }

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(channel, data)
      }
    } catch (err) {
      console.error(`[RealtimeOrderHandler] emit failed: ${channel}`, err)
    }
  }
}

