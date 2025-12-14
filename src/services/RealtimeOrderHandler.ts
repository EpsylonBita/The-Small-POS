import type { BrowserWindow } from 'electron'
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js'
import { getSupabaseClient } from '../shared/supabase-config'
import type { DatabaseManager } from '../main/database'

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
      let orderItems = order.items
      if (!orderItems || (Array.isArray(orderItems) && orderItems.length === 0)) {
        try {
          const { data: items, error } = await this.client
            .from('order_items')
            .select('id, menu_item_id, quantity, unit_price, total_price, notes, customizations')
            .eq('order_id', order.id)
          
          if (!error && items && items.length > 0) {
            // Also fetch menu item names from subcategories table (order_items.menu_item_id references subcategories.id)
            const menuItemIds = items.map((item: any) => item.menu_item_id).filter(Boolean)
            let menuItemNames: Record<string, string> = {}
            
            if (menuItemIds.length > 0) {
              const { data: subcategories } = await this.client
                .from('subcategories')
                .select('id, name, name_en, name_el')
                .in('id', menuItemIds)
              
              if (subcategories) {
                menuItemNames = subcategories.reduce((acc: Record<string, string>, sc: any) => {
                  acc[sc.id] = sc.name || sc.name_en || sc.name_el || 'Item'
                  return acc
                }, {})
              }
            }

            // Helper function to extract name from customizations
            const extractNameFromCustomizations = (customizations: any): string | null => {
              if (!customizations || typeof customizations !== 'object') return null
              for (const key of Object.keys(customizations)) {
                const cust = customizations[key]
                if (cust?.ingredient?.name) return cust.ingredient.name
                if (cust?.name) return cust.name
              }
              return null
            }
            
            orderItems = items.map((item: any, index: number) => {
              let itemName: string = menuItemNames[item.menu_item_id] || ''
              if (!itemName) {
                const custName = extractNameFromCustomizations(item.customizations)
                if (custName) itemName = custName
              }
              if (!itemName) {
                const price = parseFloat(item.unit_price) || 0
                itemName = `Item ${index + 1} (€${price.toFixed(2)})`
              }
              return {
                id: item.id,
                menu_item_id: item.menu_item_id,
                name: itemName,
                quantity: item.quantity || 1,
                price: parseFloat(item.unit_price) || 0,
                unit_price: parseFloat(item.unit_price) || 0,
                total_price: parseFloat(item.total_price) || (parseFloat(item.unit_price) * (item.quantity || 1)),
                notes: item.notes,
                customizations: item.customizations
              }
            })
            console.log(`[RealtimeOrderHandler] Fetched ${orderItems.length} items for order ${order.id}`)
          }
        } catch (e) {
          console.warn(`[RealtimeOrderHandler] Failed to fetch order items for ${order.id}:`, e)
        }
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
      await orderService.deleteOrder(order.id)
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

