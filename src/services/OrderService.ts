// OrderService for POS system - API integration with admin dashboard
import { Order, OrderStatus } from '../shared/types/orders';
import { mapStatusForSupabase, mapStatusForPOS } from '../shared/types/order-status';
import { environment, getApiUrl, isDevelopment } from '../config/environment';
import { debugLogger } from '../shared/utils/debug-logger';
import { ErrorFactory } from '../shared/utils/error-handler';
import { API } from '../shared/constants';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
  updateTerminalCredentialCache,
} from '../renderer/services/terminal-credentials';

// Utility functions - now using centralized debug logger

export class OrderService {
  private static instance: OrderService;
  private cachedOrganizationId: string | null = null;

  public static getInstance(): OrderService {
    if (!OrderService.instance) {
      OrderService.instance = new OrderService();
    }
    return OrderService.instance;
  }

  /**
   * Resolve organization_id using multiple fallback sources.
   * Priority: cache → localStorage → Electron IPC.
   */
  private async getOrganizationId(): Promise<string | null> {
    // 1. Use in-memory cache if available
    if (this.cachedOrganizationId) {
      return this.cachedOrganizationId;
    }

    // 2. Try localStorage
    if (typeof window !== 'undefined') {
      try {
        const storedOrgId = localStorage.getItem('organization_id');
        if (storedOrgId) {
          this.cachedOrganizationId = storedOrgId;
          return storedOrgId;
        }

        // Try getting from stored staff object
        const staff = localStorage.getItem('staff');
        if (staff) {
          const parsed = JSON.parse(staff);
          if (parsed.organizationId) {
            this.cachedOrganizationId = parsed.organizationId;
            return parsed.organizationId;
          }
        }
      } catch (error) {
        console.warn('[OrderService] Failed to read organization_id from localStorage:', error);
      }
    }

    // 3. Try Electron IPC
    if (typeof window !== 'undefined') {
      const api = (window as any).electronAPI;
      if (api?.invoke) {
        try {
          // Try dedicated organization IPC (correct channel name)
          const orgId = await api.invoke('terminal-config:get-organization-id');
          if (orgId) {
            this.cachedOrganizationId = orgId;
            return orgId;
          }
        } catch (error) {
          // Ignore - try next method
        }

        try {
          // Try terminal settings (correct channel name)
          const settingsOrgId = await api.invoke('terminal-config:get-setting', 'terminal', 'organization_id');
          if (settingsOrgId) {
            this.cachedOrganizationId = settingsOrgId;
            return settingsOrgId;
          }
        } catch (error) {
          console.warn('[OrderService] Failed to get organization_id from terminal settings:', error);
        }
      }
    }

    return null;
  }

  // Cache for credentials fetched from IPC
  private cachedTerminalId: string | null = null;
  private cachedApiKey: string | null = null;

  /**
   * Get credentials from in-memory cache, then refresh from main process if needed.
   */
  private async getCredentials(): Promise<{ terminalId: string; apiKey: string }> {
    const cached = getCachedTerminalCredentials();

    // 1. Start with renderer cache and terminal id persisted metadata
    let terminalId = typeof window !== 'undefined' ? (localStorage.getItem('terminal_id') || '') : '';
    let apiKey = cached.apiKey || '';

    if (!terminalId && cached.terminalId) {
      terminalId = cached.terminalId;
    }

    // 2. If cache is empty, use service cache
    if (!terminalId && this.cachedTerminalId) terminalId = this.cachedTerminalId;
    if (!apiKey && this.cachedApiKey) apiKey = this.cachedApiKey;

    // 3. If still empty, refresh from main process via IPC
    if (!terminalId || !apiKey) {
      try {
        const refreshed = await refreshTerminalCredentialCache();
        const ipcTerminalId = refreshed.terminalId || '';
        const ipcApiKey = refreshed.apiKey || '';

        if (ipcTerminalId && !terminalId) {
          terminalId = ipcTerminalId;
          this.cachedTerminalId = ipcTerminalId;
          localStorage.setItem('terminal_id', ipcTerminalId);
        }
        if (ipcApiKey && !apiKey) {
          apiKey = ipcApiKey;
          this.cachedApiKey = ipcApiKey;
          updateTerminalCredentialCache({ apiKey: ipcApiKey });
        }
      } catch (err) {
        console.warn('[OrderService] Failed to fetch credentials from IPC:', err);
      }
    }

    // 4. Final fallback for terminal id only; API key must come from paired terminal config
    if (!terminalId) terminalId = environment.TERMINAL_ID || 'terminal-001';

    return { terminalId, apiKey };
  }

  private buildHeadersSync(): Record<string, string> {
    const lsTerminal = typeof window !== 'undefined' ? (localStorage.getItem('terminal_id') || '') : ''
    const terminalId = lsTerminal || this.cachedTerminalId || environment.TERMINAL_ID || 'terminal-001'
    const cached = getCachedTerminalCredentials()
    const apiKey = cached.apiKey || this.cachedApiKey || ''
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Help CORS allow-list on admin API
      'Origin': environment.ADMIN_DASHBOARD_URL
    }
    if (terminalId) headers['x-terminal-id'] = terminalId
    if (apiKey) headers['x-pos-api-key'] = apiKey

    // Debug logging
    if (!apiKey) {
      console.warn('[OrderService] ⚠️ POS API Key is MISSING! Requests will likely fail (401). Check Terminal Settings.');
    }
    console.log('[OrderService] Building headers:', {
      terminalId: terminalId || 'MISSING',
      apiKeyPresent: !!apiKey,
      hasPosApiKeyHeader: !!headers['x-pos-api-key']
    })

    return headers
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const { terminalId, apiKey } = await this.getCredentials();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Help CORS allow-list on admin API
      'Origin': environment.ADMIN_DASHBOARD_URL
    }
    if (terminalId) headers['x-terminal-id'] = terminalId
    if (apiKey) headers['x-pos-api-key'] = apiKey

    // Debug logging
    if (!apiKey) {
      console.warn('[OrderService] ⚠️ POS API Key is MISSING! Requests will likely fail (401). Check Terminal Settings.');
    }
    console.log('[OrderService] Building headers:', {
      terminalId: terminalId || 'MISSING',
      apiKeyPresent: !!apiKey,
      hasPosApiKeyHeader: !!headers['x-pos-api-key']
    })

    return headers
  }

  // Fetch orders - prefer local (IPC) first, fallback to Admin API
  async fetchOrders(): Promise<Order[]> {
    try {
      // 1) Try local-first via Electron IPC (renderer -> main -> SQLite)
      if (typeof window !== 'undefined') {
        const api = (window as any).electronAPI;
        if (api?.invoke) {
          try {
            const result = await api.invoke('order:get-all');
            // Handle IPC response format: { success: true, data: [...] } or direct array
            const orders = result?.data ?? result;
            if (Array.isArray(orders)) {
              // Normalize statuses for POS UI (map server 'completed' -> POS 'delivered')
              const normalized = (orders as any[]).map((o) => ({
                ...o,
                status: o?.status ? mapStatusForPOS(o.status as any) : o?.status
              }));
              debugLogger.info(`Fetched ${normalized.length} orders via IPC (local DB)`, 'OrderService');
              return normalized as Order[];
            }
          } catch (ipcErr) {
            debugLogger.warn('IPC fetchOrders failed, falling back to Admin API', ipcErr, 'OrderService');
          }
        }
      }

      // 2) Fallback to Admin Dashboard API (ensures Admin /orders stays in sync through Supabase)
      const headers = await this.buildHeaders();
      const organizationId = await this.getOrganizationId();

      // Build URL with organization_id query parameter
      let url = getApiUrl('/pos/orders');
      if (organizationId) {
        url += `?organization_id=${encodeURIComponent(organizationId)}`;
      }

      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.error('[OrderService] ❌ 401 Unauthorized. Credentials rejected.');
          throw ErrorFactory.authentication('POS authentication failed: Check Terminal ID and API Key in Settings.');
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const result = await response.json();
      const ordersRaw = Array.isArray(result) ? result : (result.data || []);
      // Map server statuses to POS statuses to keep Delivered/Canceled sticky in UI
      const orders = ordersRaw.map((o: any) => ({
        ...o,
        status: o?.status ? mapStatusForPOS(o.status as any) : o?.status
      }));
      debugLogger.info(`Fetched ${orders.length} orders from Admin API`, 'OrderService');
      return orders;
    } catch (error) {
      const posError = ErrorFactory.network('Failed to fetch orders');
      debugLogger.error('Failed to fetch orders', error, 'OrderService');
      throw posError;
    }
  }

  // Update order status - local-first via IPC, fallback to Admin API
  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    console.log('[RENDERER OrderService] 🔄 updateOrderStatus called', { orderId, status, timestamp: new Date().toISOString() });
    try {
      // 1) Try local-first via IPC
      if (typeof window !== 'undefined') {
        const api = (window as any).electronAPI;
        if (api?.invoke) {
          try {
            console.log('[RENDERER OrderService] 📤 Invoking IPC order:update-status', { orderId, status });
            const resp: any = await api.invoke('order:update-status', { orderId, status });
            console.log('[RENDERER OrderService] 📥 IPC response received', { resp, orderId, status });
            if (resp && resp.success) {
              debugLogger.info(`Order status updated locally via IPC`, { orderId, status }, 'OrderService');
              console.log('[RENDERER OrderService] ✅ IPC update successful, returning');
              return;
            }
            // If IPC returns error, log and continue to fallback
            if (resp && resp.error) {
              console.warn('[RENDERER OrderService] ⚠️ IPC returned error:', resp.error);
              debugLogger.warn('IPC update-status returned error; will try Admin API', resp.error, 'OrderService');
            }
          } catch (ipcErr) {
            console.error('[RENDERER OrderService] ❌ IPC call threw error:', ipcErr);
            debugLogger.warn('IPC update-status failed; will try Admin API', ipcErr, 'OrderService');
          }
        }
      }

      // 2) Fallback to Admin API (propagates to Supabase and back via realtime)
      const headers = await this.buildHeaders();
      // Resolve a server-recognizable identifier: prefer Supabase ID, then order_number, else best-effort
      let idToSend: string = orderId;
      if (typeof window !== 'undefined') {
        const api = (window as any).electronAPI;
        if (api?.invoke) {
          try {
            const order: any = await api.invoke('order:get-by-id', { orderId });
            if (order) {
              // Prefer Supabase ID; otherwise send order_number (server resolves UUID/order_number/client_order_id)
              idToSend = order.supabase_id || order.supabaseId || order.order_number || order.orderNumber || orderId;
            }
          } catch (_) {
            // ignore - continue with heuristics
          }
        }
      }
      // Heuristic: if it looks like a UUID or an order_number (ORD-...), send as-is; otherwise server will also try client_order_id
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      // If it's not a UUID and doesn't look like our POS order_number, leave as-is; server also tries client_order_id.
      debugLogger.info('Updating order via Admin API', { originalId: orderId, idSent: idToSend, status }, 'OrderService');
      const supaStatus = mapStatusForSupabase(status as any);

      // Include organization_id in request body
      const organizationId = await this.getOrganizationId();
      const requestBody: any = { id: idToSend, status: supaStatus };
      if (organizationId) {
        requestBody.organization_id = organizationId;
      }

      const response = await fetch(getApiUrl('/pos/orders'), {
        method: 'PATCH',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        let bodyText = ''
        let bodyJson: any = null
        try {
          bodyText = await response.text()
          try { bodyJson = JSON.parse(bodyText) } catch { }
        } catch { }

        const details = bodyJson || bodyText || null
        const statusCode = response.status
        if (statusCode === 400) {
          const message = (bodyJson?.error || 'Validation failed') + (bodyJson?.details ? `: ${JSON.stringify(bodyJson.details)}` : '')
          throw ErrorFactory.validation(message)
        }
        if (statusCode === 401 || statusCode === 403) {
          throw ErrorFactory.authentication('POS authentication failed: check terminal ID and API key')
        }
        if (statusCode === 404) {
          throw ErrorFactory.businessLogic('Order not found or not accessible for this terminal', { details })
        }
        if (statusCode === 429) {
          throw ErrorFactory.system('Rate limit reached. Please wait a moment and try again.')
        }
        throw ErrorFactory.network(`Request failed with status ${statusCode}`)
      }
    } catch (error) {
      debugLogger.error('Failed to update order status', error, 'OrderService');
      throw error;
    }
  }

  // Lightweight connectivity check to Admin POS API
  async testConnection(): Promise<{ ok: boolean; status: number; message?: string }> {
    try {
      const headers = await this.buildHeaders();
      const url = getApiUrl('/pos/orders?limit=1')
      const response = await fetch(url, { method: 'GET', headers })
      if (response.ok) return { ok: true, status: response.status }

      let msg = ''
      try { msg = await response.text() } catch { }
      return { ok: false, status: response.status, message: msg || 'Non-OK response' }
    } catch (e: any) {
      return { ok: false, status: 0, message: e?.message || 'Network error' }
    }
  }

  // Create new order - local-first via IPC, fallback to Admin API
  async createOrder(orderData: Partial<Order>): Promise<Order> {
    try {
      // Normalize incoming orderData for main process expectations
      // NOTE: For delivery orders, if deliveryAddress is missing, the backend will attempt
      // to resolve the address from the customer record using customerId. Ensure that:
      // 1. Delivery orders with persisted customers always pass customerId
      // 2. Delivery orders without persisted customers always pass a non-empty deliveryAddress
      const normalized: any = {
        // Include customerId for backend address fallback resolution
        customerId: (orderData as any).customerId ?? orderData.customer_id ?? null,
        customerName: (orderData as any).customerName ?? orderData.customer_name,
        customerPhone: orderData.customerPhone ?? orderData.customer_phone,
        customerEmail: (orderData as any).customerEmail ?? orderData.customer_email,
        items: orderData.items || [],
        totalAmount: (orderData.totalAmount ?? orderData.total_amount) as number,
        // Discount and fee fields
        subtotal: (orderData as any).subtotal ?? (orderData as any).total ?? null,
        discountAmount: (orderData as any).discountAmount ?? (orderData as any).discount_amount ?? 0,
        discountPercentage: (orderData as any).discountPercentage ?? (orderData as any).discount_percentage ?? 0,
        deliveryFee: (orderData as any).deliveryFee ?? (orderData as any).delivery_fee ?? 0,
        status: orderData.status,
        orderType: (orderData.orderType ?? orderData.order_type) as any,
        tableNumber: orderData.tableNumber ?? orderData.table_number,
        deliveryAddress: (orderData as any).address ?? orderData.delivery_address,
        delivery_notes: orderData.delivery_notes ?? (orderData as any).deliveryNotes ?? null,
        name_on_ringer: orderData.name_on_ringer ?? (orderData as any).nameOnRinger ?? null,
        notes: orderData.notes ?? orderData.special_instructions,
        estimatedTime: orderData.estimatedTime ?? orderData.estimated_time,
        paymentStatus: orderData.paymentStatus ?? orderData.payment_status,
        paymentMethod: orderData.paymentMethod ?? orderData.payment_method,
        paymentTransactionId: orderData.paymentTransactionId ?? orderData.payment_transaction_id,
      };

      // 1) Try local-first via IPC
      if (typeof window !== 'undefined') {
        const api = (window as any).electronAPI;
        if (api?.invoke) {
          try {
            const resp: any = await api.invoke('order:create', { orderData: normalized });
            // handleIPCError wrapper returns { success, data } where data contains { orderId }
            // Also handle legacy format where orderId is directly on resp
            const orderId = resp?.data?.orderId || resp?.orderId;
            const isSuccess = resp?.success === true;
            if (isSuccess && orderId) {
              const created: any = await api.invoke('order:get-by-id', { orderId });
              if (created) {
                debugLogger.info('Created order via IPC', { orderId }, 'OrderService');
                return created as Order;
              }
            }
            if (resp && resp.error) {
              debugLogger.warn('IPC create returned error; will try Admin API', resp.error, 'OrderService');
            }
          } catch (ipcErr) {
            debugLogger.warn('IPC create failed; will try Admin API', ipcErr, 'OrderService');
          }
        }
      }

      // 2) Fallback to Admin API
      // Transform orderData to match Admin API schema
      const branchId = typeof window !== 'undefined' ? localStorage.getItem('branch_id') : null;
      const organizationId = await this.getOrganizationId();
      const orderDataAny = orderData as any;

      // Map order_type: 'takeaway' -> 'pickup', 'dine-in' -> 'dine-in', 'delivery' -> 'delivery'
      let orderType = orderData.order_type || orderDataAny.orderType || 'pickup';
      if (orderType === 'takeaway' || orderType === 'takeout') orderType = 'pickup';

      // Map payment_status: 'completed' -> 'paid'
      let paymentStatus = orderData.payment_status || orderDataAny.paymentStatus || 'pending';
      if (paymentStatus === 'completed') paymentStatus = 'paid';

      // Try to resolve active cashier shift to attribute revenue properly
      let activeCashierShiftId: string | null = null;
      try {
        const api = (typeof window !== 'undefined') ? (window as any).electronAPI : null;
        if (api?.getActiveShiftByTerminalLoose) {
          const tId = (typeof window !== 'undefined') ? (localStorage.getItem('terminal_id') || environment.TERMINAL_ID || 'terminal-001') : 'terminal-001';
          const shift = await api.getActiveShiftByTerminalLoose(tId);
          if (shift && shift.role_type === 'cashier') {
            activeCashierShiftId = shift.id;
          }
        }
      } catch { }

      const apiPayload: any = {
        // Required fields
        branch_id: branchId || orderDataAny.branch_id,
        organization_id: organizationId || orderDataAny.organization_id,
        items: (orderData.items || []).map((item: any) => ({
          menu_item_id: item.menu_item_id || item.menuItemId || item.id,
          quantity: item.quantity || 1,
          // Use totalPrice first (includes customizations), then unit_price, then price as fallback
          unit_price: item.totalPrice || item.unit_price || item.price || 0,
          customizations: Array.isArray(item.customizations)
            ? item.customizations.reduce((acc: any, c: any, idx: number) => {
              // Generate a unique key for each customization
              // Priority: customizationId > optionId > name > ingredient.id > ingredient.name > fallback
              // IMPORTANT: Check customizationId/optionId/name FIRST since MenuPage format doesn't have ingredient object
              let key: string;
              if (c.customizationId && typeof c.customizationId === 'string') key = c.customizationId;
              else if (c.optionId && typeof c.optionId === 'string') key = c.optionId;
              else if (c.name && typeof c.name === 'string') key = c.name;
              else if (c.ingredient?.id && typeof c.ingredient.id === 'string') key = c.ingredient.id;
              else if (c.ingredient?.name && typeof c.ingredient.name === 'string') key = c.ingredient.name;
              else key = `item-${idx}`;
              acc[key] = c;
              return acc;
            }, {})
            : (item.customizations || null),
          notes: item.notes || null
        })),
        order_type: orderType,
        payment_method: orderData.payment_method || orderDataAny.paymentMethod || 'cash',
        payment_status: paymentStatus,
        total_amount: orderData.total_amount || orderDataAny.totalAmount || 0,

        // Optional fields - use ?? for numbers to handle 0 values correctly
        customer_id: orderData.customer_id || null,
        customer_name: orderData.customer_name || orderDataAny.customerName || null,
        customer_phone: orderData.customer_phone || orderDataAny.customerPhone || null,
        subtotal: orderDataAny.subtotal ?? 0,
        tax_amount: orderDataAny.tax ?? orderData.taxAmount ?? 0,
        discount_amount: orderDataAny.discount_amount ?? 0,
        delivery_fee: orderDataAny.delivery_fee ?? orderData.deliveryFee ?? 0,
        delivery_address: orderData.delivery_address || orderDataAny.deliveryAddress || null,
        notes: orderData.notes || orderData.special_instructions || null,
        staff_shift_id: activeCashierShiftId || null
      };

      // Validate branch_id is present
      if (!apiPayload.branch_id) {
        console.error('[OrderService] Missing branch_id! Please configure terminal in Connection Settings.');
        throw new Error('Branch ID not configured. Please check Connection Settings.');
      }

      // Warn if organization_id could not be resolved
      if (!apiPayload.organization_id) {
        console.warn('[OrderService] organization_id not configured. Order may fail organization validation on the server.');
      }

      console.log('[OrderService] Sending to Admin API:', {
        branch_id: apiPayload.branch_id,
        itemCount: apiPayload.items.length,
        order_type: apiPayload.order_type,
        total_amount: apiPayload.total_amount,
        delivery_address: apiPayload.delivery_address,
        customer_name: apiPayload.customer_name,
        firstItem: apiPayload.items[0] ? {
          menu_item_id: apiPayload.items[0].menu_item_id,
          quantity: apiPayload.items[0].quantity,
          unit_price: apiPayload.items[0].unit_price
        } : null
      });

      const headers = await this.buildHeaders();
      const response = await fetch(getApiUrl('/pos/orders'), {
        method: 'POST',
        headers,
        body: JSON.stringify(apiPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[OrderService] Admin API error:', errorText);
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      const newOrder = result.data || result;
      debugLogger.info(`Created order via Admin API: ${newOrder.id}`, 'OrderService');

      // Sync the order to local SQLite so it appears in the POS order list
      if (typeof window !== 'undefined') {
        const api = (window as any).electronAPI;
        if (api?.invoke) {
          try {
            const syncResp = await api.invoke('order:save-from-remote', { orderData: newOrder });
            if (syncResp?.success) {
              debugLogger.info(`Synced remote order to local DB: ${syncResp.orderId}`, 'OrderService');
            } else {
              debugLogger.warn('Failed to sync remote order to local DB', syncResp, 'OrderService');
            }
          } catch (syncErr) {
            debugLogger.warn('Error syncing remote order to local DB', syncErr, 'OrderService');
          }
        }
      }

      return newOrder;
    } catch (error) {
      const posError = ErrorFactory.network('Failed to create order');
      debugLogger.error('Failed to create order', error, 'OrderService');
      throw posError;
    }
  }

  // Delete order - local-first via IPC, fallback to Admin API
  async deleteOrder(orderId: string): Promise<void> {
    try {
      // 1) Try local-first via IPC
      if (typeof window !== 'undefined') {
        const api = (window as any).electronAPI;
        if (api?.invoke) {
          try {
            const resp: any = await api.invoke('order:delete', { orderId });
            if (resp && resp.success) {
              debugLogger.info('Deleted order via IPC', { orderId }, 'OrderService');
              return;
            }
            if (resp && resp.error) {
              debugLogger.warn('IPC delete returned error; will try Admin API', resp.error, 'OrderService');
            }
          } catch (ipcErr) {
            debugLogger.warn('IPC delete failed; will try Admin API', ipcErr, 'OrderService');
          }
        }
      }

      // 2) Fallback to Admin API
      const headers = await this.buildHeaders();
      const organizationId = await this.getOrganizationId();

      // Build URL with organization_id query parameter
      let url = getApiUrl(`/pos/orders?id=${orderId}`);
      if (organizationId) {
        url += `&organization_id=${encodeURIComponent(organizationId)}`;
      }

      const response = await fetch(url, { method: 'DELETE', headers });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    } catch (error) {
      console.error('❌ Failed to delete order:', error);
      throw error;
    }
  }
}
