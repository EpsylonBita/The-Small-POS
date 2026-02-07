import Database from 'better-sqlite3';
import { BaseService } from './BaseService';

// Database row interfaces
interface OrderRow {
  id: string;
  order_number?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  items: string; // JSON string
  total_amount: number;
  tax_amount?: number;
  status: 'pending' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered' | 'completed' | 'cancelled';
  cancellation_reason?: string;
  order_type?: 'dine-in' | 'takeaway' | 'delivery';
  table_number?: string;
  delivery_address?: string;
  delivery_notes?: string;
  name_on_ringer?: string;
  special_instructions?: string;
  created_at: string;
  updated_at: string;
  estimated_time?: number;
  supabase_id?: string;
  sync_status: 'synced' | 'pending' | 'failed';
  payment_status?: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
  payment_method?: string;
  payment_transaction_id?: string;
  staff_shift_id?: string;
  staff_id?: string;
  driver_id?: string;
  driver_name?: string;
  discount_percentage?: number;
  discount_amount?: number;
  tip_amount?: number;
  // Versioning and sync metadata
  version?: number;
  updated_by?: string;
  last_synced_at?: string;
  remote_version?: number;
  delivery_floor?: string;
  delivery_city?: string;
  delivery_postal_code?: string;
  // Plugin tracking
  plugin?: string;
  external_plugin_order_id?: string;
  plugin_commission_pct?: number;
  net_earnings?: number;
  terminal_id?: string;
  branch_id?: string;
}

interface OrderFilters {
  status?: string;
  fromDate?: string;
  toDate?: string;
  customerId?: string;
  paymentStatus?: string;
  date?: string;
  limit?: number;
  offset?: number;
  afterTimestamp?: string; // Filter orders created after this ISO timestamp (for Z-Report filtering)
}

export interface Order {
  id: string;
  order_number?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  items: OrderItem[];
  total_amount: number;
  tax_amount?: number;
  status: 'pending' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered' | 'completed' | 'cancelled';
  cancellation_reason?: string;
  order_type?: 'dine-in' | 'takeaway' | 'delivery';
  table_number?: string;
  delivery_address?: string;
  delivery_notes?: string;
  delivery_floor?: string;
  delivery_city?: string;
  delivery_postal_code?: string;
  name_on_ringer?: string;
  special_instructions?: string;
  created_at: string;
  updated_at: string;
  estimated_time?: number;
  supabase_id?: string;
  sync_status: 'synced' | 'pending' | 'failed';
  payment_status?: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
  payment_method?: string;
  payment_transaction_id?: string;
  staff_shift_id?: string;
  staff_id?: string;
  driver_id?: string;
  driver_name?: string;
  discount_percentage?: number;
  discount_amount?: number;
  tip_amount?: number;
  // Financial breakdown (explicitly passed from frontend)
  subtotal?: number;
  tax_rate?: number; // Percentage, e.g., 24 for 24%
  delivery_fee?: number;
  // Versioning and sync metadata
  version?: number;
  updated_by?: string;
  last_synced_at?: string;
  remote_version?: number;
  // Platform tracking (for external platform orders like Wolt, Efood, etc.)
  plugin?: string;
  external_plugin_order_id?: string;
  plugin_commission_pct?: number;
  net_earnings?: number;
  terminal_id?: string;
  branch_id?: string;
  // Backward compatibility
  platform?: string;
  external_platform_order_id?: string;
  platform_commission_pct?: number;
}

export interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  notes?: string;
}

// Default tax rate (24% Greek VAT) - used only as fallback when not provided
const DEFAULT_TAX_RATE_PERCENTAGE = 24;

/**
 * Order financial data that can be passed explicitly from frontend or derived.
 */
export interface OrderFinancialData {
  total_amount?: number;
  subtotal?: number;
  tax_amount?: number;
  tax_rate?: number; // Percentage, e.g., 24 for 24%
  delivery_fee?: number;
  discount_amount?: number;
  order_type?: string;
}

/**
 * Gets order financials - uses explicit values if provided, otherwise derives from total_amount.
 *
 * Frontend now passes explicit values: subtotal, tax_amount, tax_rate, delivery_fee
 * This ensures the values stored in Supabase match exactly what was shown to the user.
 *
 * Fallback derivation (for legacy orders without explicit values):
 * If total_amount is provided but subtotal/tax_amount are not, we derive using configured tax rate.
 * Formula: total_amount = subtotal + tax_amount + delivery_fee
 *
 * @param data - Order financial data with explicit or partial values
 * @returns Object with subtotal, tax_amount, and delivery_fee
 */
export function deriveOrderFinancials(
  totalAmount: number | undefined,
  orderType: string | undefined,
  discountAmount: number = 0,
  explicitData?: Partial<OrderFinancialData>
): { subtotal: number; tax_amount: number; delivery_fee: number } {
  // If explicit values are provided, use them directly
  if (explicitData?.subtotal !== undefined && explicitData?.tax_amount !== undefined) {
    return {
      subtotal: explicitData.subtotal,
      tax_amount: explicitData.tax_amount,
      delivery_fee: explicitData.delivery_fee ?? 0
    };
  }

  // Fallback: derive from total_amount (for legacy orders)
  if (!totalAmount || totalAmount <= 0) {
    return { subtotal: 0, tax_amount: 0, delivery_fee: 0 };
  }

  // Use explicit delivery fee if provided, otherwise 0 (we no longer assume a default)
  const deliveryFee = explicitData?.delivery_fee ?? 0;

  // Use explicit tax rate if provided (percentage), otherwise use default
  const taxRatePercentage = explicitData?.tax_rate ?? DEFAULT_TAX_RATE_PERCENTAGE;
  const taxRate = taxRatePercentage / 100;

  // Taxable amount = total - delivery fee (delivery fee is not taxed)
  const taxableAmount = totalAmount - deliveryFee;

  // taxableAmount = items_subtotal * (1 + taxRate), so items_subtotal = taxableAmount / (1 + taxRate)
  const itemsSubtotal = Number((taxableAmount / (1 + taxRate)).toFixed(2));

  // Tax is the difference
  const taxAmount = Number((taxableAmount - itemsSubtotal).toFixed(2));

  // For Supabase, subtotal includes discount adjustment
  const subtotal = itemsSubtotal + discountAmount;

  return {
    subtotal,
    tax_amount: taxAmount,
    delivery_fee: deliveryFee
  };
}

export class OrderService extends BaseService {
  constructor(database: Database.Database) {
    super(database);
  }


  // Resolve terminal and branch identifiers from local settings with safe fallbacks
  private getLocalSetting(category: string, key: string): any {
    try {
      const row = this.db.prepare(
        `SELECT setting_value FROM local_settings
         WHERE setting_category = ? AND setting_key = ?
         ORDER BY updated_at DESC LIMIT 1`
      ).get(category, key) as { setting_value: string } | undefined;
      if (!row) return null;
      try { return JSON.parse(row.setting_value); } catch { return row.setting_value; }
    } catch {
      return null;
    }
  }


  createOrder(orderData: Partial<Order>): Order {
    return this.executeTransaction(() => {
      // Validate required fields
      this.validateRequired(orderData, ['items', 'total_amount', 'status']);

      // Get terminal ID from environment or generate one
      const terminalId = process.env.TERMINAL_ID || 'terminal-' + this.generateId().substring(0, 8);
      const branchId = (orderData as any).branch_id ?? this.getLocalSetting('terminal', 'branch_id') ?? null;
      const taxAmount =
        (orderData as any).tax_amount ??
        (orderData as any).taxAmount ??
        (orderData as any).tax ??
        null;
      const cancellationReason =
        (orderData as any).cancellation_reason ??
        (orderData as any).cancellationReason ??
        null;

      const order: Order = {
        id: this.generateId(),
        order_number: orderData.order_number || this.generateOrderNumber(),
        customer_name: orderData.customer_name,
        customer_phone: orderData.customer_phone,
        customer_email: orderData.customer_email,
        items: orderData.items || [],
        total_amount: orderData.total_amount || 0,
        tax_amount: taxAmount,
        status: orderData.status || 'pending',
        cancellation_reason: cancellationReason,
        order_type: orderData.order_type || 'takeaway',
        table_number: orderData.table_number,
        delivery_address: orderData.delivery_address,
        delivery_notes: orderData.delivery_notes,
        delivery_floor: orderData.delivery_floor,
        delivery_city: orderData.delivery_city,
        delivery_postal_code: orderData.delivery_postal_code,
        name_on_ringer: orderData.name_on_ringer,
        special_instructions: orderData.special_instructions,
        created_at: this.getCurrentTimestamp(),
        updated_at: this.getCurrentTimestamp(),
        estimated_time: orderData.estimated_time,
        supabase_id: orderData.supabase_id,
        sync_status: 'pending',
        payment_status: orderData.payment_status || 'pending',
        payment_method: orderData.payment_method,
        payment_transaction_id: orderData.payment_transaction_id,
        staff_shift_id: orderData.staff_shift_id,
        staff_id: orderData.staff_id,
        driver_id: orderData.driver_id,
        discount_percentage: orderData.discount_percentage,
        discount_amount: orderData.discount_amount,
        tip_amount: orderData.tip_amount,
        plugin: orderData.plugin || orderData.platform || 'pos',
        external_plugin_order_id: orderData.external_plugin_order_id || orderData.external_platform_order_id,
        plugin_commission_pct: orderData.plugin_commission_pct || orderData.platform_commission_pct,
        net_earnings: orderData.net_earnings,
        terminal_id: orderData.terminal_id || terminalId,
        branch_id: branchId,
        // Versioning and sync metadata
        version: 1,
        updated_by: terminalId
      };

      const stmt = this.db.prepare(`
        INSERT INTO orders (
          id, order_number, customer_name, customer_phone, customer_email,
          items, total_amount, tax_amount, status, cancellation_reason, order_type, table_number,
          delivery_address, delivery_notes, delivery_floor, delivery_city, delivery_postal_code, name_on_ringer, special_instructions, created_at, updated_at,
          estimated_time, supabase_id, sync_status, payment_status,
          payment_method, payment_transaction_id, staff_shift_id, staff_id,
          driver_id, driver_name, discount_percentage, discount_amount, tip_amount,
          plugin, external_plugin_order_id, plugin_commission_pct, net_earnings, terminal_id, branch_id,
          version, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);



      stmt.run(
        order.id, order.order_number, order.customer_name, order.customer_phone,
        order.customer_email, JSON.stringify(order.items), order.total_amount,
        order.tax_amount, order.status, order.cancellation_reason, order.order_type, order.table_number, order.delivery_address,
        order.delivery_notes || null, order.delivery_floor || null, order.delivery_city || null,
        order.delivery_postal_code || null, order.name_on_ringer || null,
        order.special_instructions, order.created_at, order.updated_at,
        order.estimated_time, order.supabase_id, order.sync_status,
        order.payment_status, order.payment_method, order.payment_transaction_id,
        order.staff_shift_id || null, order.staff_id || null, order.driver_id || null,
        order.driver_name || null,
        order.discount_percentage || null, order.discount_amount || null, order.tip_amount || null,
        order.plugin || null, order.external_plugin_order_id || null, order.plugin_commission_pct || null, order.net_earnings || null, order.terminal_id || null, order.branch_id || null,
        order.version, order.updated_by
      );

      // Queue order for remote sync (insert)
      const __tid = (this.getLocalSetting('terminal', 'terminal_id') as string | null) || (process.env.TERMINAL_ID || null);
      const __bid = (this.getLocalSetting('terminal', 'branch_id') as string | null) || null;
      const cashierShift = this.db.prepare(`
        SELECT id FROM staff_shifts WHERE status = 'active' AND role_type = 'cashier' ORDER BY check_in_time DESC LIMIT 1
      `).get() as any;
      const staffShiftId = order.staff_shift_id || cashierShift?.id || null;
      // attach shift for cashier-controlled orders
      if (staffShiftId) {
        try {
          this.db.prepare('UPDATE orders SET staff_shift_id = ? WHERE id = ?').run(staffShiftId, order.id);
        } catch { }
      }
      // Get financial breakdown - use explicit values from order if provided, otherwise derive
      const financials = deriveOrderFinancials(
        order.total_amount,
        order.order_type,
        order.discount_amount ?? 0,
        {
          subtotal: order.subtotal,
          tax_amount: order.tax_amount,
          tax_rate: order.tax_rate,
          delivery_fee: order.delivery_fee
        }
      );

      this.addToSyncQueue('orders', order.id, 'insert', {
        // Ensure remote can resolve by order_number
        order_number: order.order_number,
        customer_name: order.customer_name ?? null,
        customer_email: order.customer_email ?? null,
        customer_phone: order.customer_phone ?? null,
        order_type: order.order_type ?? 'takeaway',
        status: order.status,
        // Financial fields - use explicit values if provided, otherwise derived
        total_amount: order.total_amount,
        tax_amount: financials.tax_amount,
        discount_amount: order.discount_amount ?? 0,
        subtotal: financials.subtotal,
        delivery_fee: financials.delivery_fee,
        payment_status: order.payment_status ?? 'pending',
        payment_method: order.payment_method ?? null,
        notes: order.special_instructions ?? null,
        delivery_notes: order.delivery_notes ?? null,
        delivery_floor: order.delivery_floor ?? null,
        delivery_city: order.delivery_city ?? null,
        delivery_postal_code: order.delivery_postal_code ?? null,
        name_on_ringer: order.name_on_ringer ?? null,
        table_number: order.table_number ?? null,
        estimated_ready_time: order.estimated_time ?? null,
        terminal_id: __tid,
        branch_id: __bid,
        staff_shift_id: staffShiftId,
        created_at: order.created_at,
        updated_at: order.updated_at
      });

      return order;
    });
  }

  getOrder(id: string): Order | null {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE id = ?');
    const row = stmt.get(id) as OrderRow | undefined;

    if (!row) return null;

    return this.mapRowToOrder(row);
  }

  getOrderBySupabaseId(supabaseId: string): Order | null {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE supabase_id = ?');
    const row = stmt.get(supabaseId) as OrderRow | undefined;

    if (!row) return null;

    return this.mapRowToOrder(row);
  }

  getOrderByOrderNumber(orderNumber: string): Order | null {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE order_number = ?');
    const row = stmt.get(orderNumber) as OrderRow | undefined;

    if (!row) return null;

    return this.mapRowToOrder(row);
  }

  updateSupabaseId(orderId: string, supabaseId: string): void {
    const stmt = this.db.prepare('UPDATE orders SET supabase_id = ? WHERE id = ?');
    stmt.run(supabaseId, orderId);
  }

  getAllOrders(filters?: OrderFilters): Order[] {
    let query = 'SELECT * FROM orders';
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (filters?.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }

    if (filters?.date) {
      conditions.push('date(created_at) = ?');
      params.push(filters.date);
    }

    // If fromDate is specified, only get orders from that date onwards
    if (filters?.fromDate) {
      conditions.push('date(created_at) >= ?');
      params.push(filters.fromDate);
    }

    // If afterTimestamp is specified, only get orders created AFTER that timestamp
    // This is used for Z-Report filtering - orders before the Z-Report timestamp are excluded
    if (filters?.afterTimestamp) {
      conditions.push('created_at > ?');
      params.push(filters.afterTimestamp);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    if (filters?.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);

      if (filters?.offset) {
        query += ' OFFSET ?';
        params.push(filters.offset);
      }
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as OrderRow[];

    return rows.map(row => this.mapRowToOrder(row));
  }

  updateOrder(id: string, updates: Partial<Order>): Order | null {
    return this.executeTransaction(() => {
      const existingOrder = this.getOrder(id);
      if (!existingOrder) return null;

      // Get terminal ID
      const terminalId = process.env.TERMINAL_ID || 'terminal-' + this.generateId().substring(0, 8);

      const updatedOrder: Order = {
        ...existingOrder,
        ...updates,
        updated_at: this.getCurrentTimestamp(),
        sync_status: 'pending' as const,
        // Increment version and update metadata
        version: (existingOrder.version || 1) + 1,
        updated_by: terminalId
      };

      const stmt = this.db.prepare(`
        UPDATE orders SET
          customer_name = ?, customer_phone = ?, customer_email = ?,
          items = ?, total_amount = ?, status = ?, order_type = ?,
          table_number = ?, delivery_address = ?, special_instructions = ?,
          delivery_floor = ?, delivery_city = ?, delivery_postal_code = ?,
          updated_at = ?, estimated_time = ?, supabase_id = ?,
          sync_status = ?, payment_status = ?, payment_method = ?,
          payment_transaction_id = ?, staff_shift_id = ?, staff_id = ?,
          driver_id = ?, driver_name = ?, discount_percentage = ?, discount_amount = ?, tip_amount = ?,
          plugin = ?, external_plugin_order_id = ?, plugin_commission_pct = ?, net_earnings = ?, terminal_id = ?,
          version = ?, updated_by = ?
        WHERE id = ?
      `);

      stmt.run(
        updatedOrder.customer_name, updatedOrder.customer_phone, updatedOrder.customer_email,
        JSON.stringify(updatedOrder.items), updatedOrder.total_amount, updatedOrder.status,
        updatedOrder.order_type, updatedOrder.table_number, updatedOrder.delivery_address,
        updatedOrder.special_instructions, updatedOrder.delivery_floor || null,
        updatedOrder.delivery_city || null, updatedOrder.delivery_postal_code || null,
        updatedOrder.updated_at, updatedOrder.estimated_time,
        updatedOrder.supabase_id, updatedOrder.sync_status, updatedOrder.payment_status,
        updatedOrder.payment_method, updatedOrder.payment_transaction_id,
        updatedOrder.staff_shift_id || null, updatedOrder.staff_id || null,
        updatedOrder.driver_id || null, updatedOrder.driver_name || null,
        updatedOrder.discount_percentage || null,
        updatedOrder.discount_amount || null, updatedOrder.tip_amount || null,
        updatedOrder.plugin || null, updatedOrder.external_plugin_order_id || null, updatedOrder.plugin_commission_pct || null, updatedOrder.net_earnings || null, updatedOrder.terminal_id || null,
        updatedOrder.version, updatedOrder.updated_by, id
      );

      // Queue order update for remote sync
      const __tid_u = (this.getLocalSetting('terminal', 'terminal_id') as string | null) || (process.env.TERMINAL_ID || null);
      const __bid_u = (this.getLocalSetting('terminal', 'branch_id') as string | null) || null;
      const cashierShift = this.db.prepare(`
        SELECT id FROM staff_shifts WHERE status = 'active' AND role_type = 'cashier' ORDER BY check_in_time DESC LIMIT 1
      `).get() as any;
      const staffShiftId = updatedOrder.staff_shift_id || cashierShift?.id || null;

      // Get financial breakdown - use explicit values if provided, otherwise derive
      const updateFinancials = deriveOrderFinancials(
        updatedOrder.total_amount,
        updatedOrder.order_type,
        updatedOrder.discount_amount ?? 0,
        {
          subtotal: updatedOrder.subtotal,
          tax_amount: updatedOrder.tax_amount,
          tax_rate: updatedOrder.tax_rate,
          delivery_fee: updatedOrder.delivery_fee
        }
      );

      this.addToSyncQueue('orders', id, 'update', {
        order_number: updatedOrder.order_number,
        customer_name: updatedOrder.customer_name ?? null,
        customer_email: updatedOrder.customer_email ?? null,
        customer_phone: updatedOrder.customer_phone ?? null,
        order_type: updatedOrder.order_type ?? null,
        status: updatedOrder.status,
        // Financial fields - use explicit values if provided, otherwise derived
        total_amount: updatedOrder.total_amount,
        tax_amount: updateFinancials.tax_amount,
        subtotal: updateFinancials.subtotal,
        discount_amount: updatedOrder.discount_amount ?? 0,
        delivery_fee: updateFinancials.delivery_fee,
        payment_status: updatedOrder.payment_status ?? null,
        payment_method: updatedOrder.payment_method ?? null,
        notes: updatedOrder.special_instructions ?? null,
        table_number: updatedOrder.table_number ?? null,
        estimated_ready_time: updatedOrder.estimated_time ?? null,
        driver_id: updatedOrder.driver_id ?? null,
        terminal_id: __tid_u,
        branch_id: __bid_u,
        staff_shift_id: staffShiftId,
        updated_at: updatedOrder.updated_at
      });

      return updatedOrder;
    });
  }

  deleteOrder(id: string): boolean {
    return this.executeTransaction(() => {
      const stmt = this.db.prepare('DELETE FROM orders WHERE id = ?');
      const result = stmt.run(id);
      return result.changes > 0;
    });
  }

  updateOrderStatus(id: string, status: Order['status']): boolean {
    // Coerce deprecated/transient statuses to canonical ones for consistency system-wide
    let nextStatus: Order['status'] = status;
    if (status === 'out_for_delivery') nextStatus = 'completed';
    if (status === 'delivered') nextStatus = 'delivered'; // Keep as delivered locally, mapped to 'completed' for Supabase in mapStatusForSupabase
    console.log('[MAIN OrderService] 🔄 updateOrderStatus called', { id, status: nextStatus, timestamp: new Date().toISOString() });

    // Check if order exists in local DB first
    const existingOrder = this.getOrder(id);
    if (!existingOrder) {
      // Try to find by supabase_id
      const orderBySupabaseId = this.getOrderBySupabaseId(id);
      if (orderBySupabaseId) {
        return this.updateOrderStatus(orderBySupabaseId.id, status); // Recursive call with local ID
      }
      return false;
    }

    // Validate before finalizing - only enforce critical validations
    if (nextStatus === 'completed' || nextStatus === 'delivered') {
      const order = this.getOrder(id);
      if (order) {
        const validationErrors = this.validateOrderForFinalization(order);
        if (validationErrors.length > 0) {
          console.warn('[OrderService] ⚠️ Order validation warnings for finalization', {
            orderId: id,
            errors: validationErrors
          });
          // Only block if there are NO items (critical error)
          const hasCriticalError = validationErrors.some(err => err.includes('no items'));
          if (hasCriticalError) {
            console.error('[OrderService] ❌ Critical validation error preventing finalization', {
              orderId: id,
              errors: validationErrors
            });
            return false;
          }
          // For other errors (missing address/table), log warning but allow the update
          // This handles orders created via admin dashboard or other sources
        }
      }
    }

    return this.executeTransaction(() => {
      const terminalId = process.env.TERMINAL_ID || 'terminal-' + this.generateId().substring(0, 8);
      const nowTs = this.getCurrentTimestamp();

      console.log('[MAIN OrderService] 💾 Updating local DB', { id, status: nextStatus, terminalId, nowTs });

      const stmt = this.db.prepare(`
        UPDATE orders SET
          status = ?,
          updated_at = ?,
          sync_status = 'pending',
          version = version + 1,
          updated_by = ?
        WHERE id = ?
      `);

      const result = stmt.run(nextStatus, nowTs, terminalId, id);
      const ok = result.changes > 0;

      console.log('[MAIN OrderService] 💾 DB update result', { ok, changes: result.changes, id, status });

      if (ok) {
        // Ensure order is attributed to active cashier shift if not already
        try {
          const cashierShift = this.db.prepare(`
            SELECT id FROM staff_shifts 
            WHERE status = 'active' AND role_type = 'cashier' 
            ORDER BY check_in_time DESC LIMIT 1
          `).get() as any;
          if (cashierShift?.id) {
            this.db.prepare('UPDATE orders SET staff_shift_id = COALESCE(staff_shift_id, ?) WHERE id = ?').run(cashierShift.id, id);
          }
        } catch { }

        // Queue status update for remote sync
        const __tid_s = (this.getLocalSetting('terminal', 'terminal_id') as string | null) || (process.env.TERMINAL_ID || null);
        const __bid_s = (this.getLocalSetting('terminal', 'branch_id') as string | null) || null;
        // Map local POS status to Supabase-compatible status to prevent status drift
        const supaStatus = this.mapStatusForSupabase(nextStatus);
        const staffShiftIdRow = this.db.prepare('SELECT staff_shift_id FROM orders WHERE id = ?').get(id) as any;
        const isUuid = (v: any) => typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
        const staffShiftId = isUuid(staffShiftIdRow?.staff_shift_id) ? staffShiftIdRow.staff_shift_id : null;

        const syncPayload = {
          status: supaStatus,
          terminal_id: __tid_s,
          branch_id: __bid_s,
          updated_at: nowTs,
          staff_shift_id: staffShiftId
        };

        console.log('[MAIN OrderService] 📋 Queueing sync UPDATE', {
          id,
          originalStatus: status,
          mappedStatus: supaStatus,
          payload: syncPayload
        });

        this.addToSyncQueue('orders', id, 'update', syncPayload);

        console.log('[MAIN OrderService] ✅ Sync queue item added for order', { id, supaStatus });
      } else {
        console.warn('[MAIN OrderService] ⚠️ DB update failed - no rows changed', { id, status });
      }

      return ok;
    });
  }

  private validateOrderForFinalization(order: Order): string[] {
    const errors: string[] = [];

    if (!order.items || order.items.length === 0) {
      errors.push('Order has no items');
    }

    if (order.total_amount <= 0 && order.items && !order.items.every((i: OrderItem) => i.price === 0)) {
      errors.push('Order total is invalid');
    }

    // Payment validation: either explicitly set or inferred
    if (!order.payment_method && order.total_amount > 0) {
      // Warn but maybe not strictly fail if it's pending?
      // errors.push('No payment method selected'); 
    }

    if (order.order_type === 'delivery' && !order.delivery_address) {
      errors.push('Missing delivery address for delivery order');
    }

    if (order.order_type === 'dine-in' && !order.table_number) {
      errors.push('Missing table number for dine-in order');
    }

    return errors;
  }

  getOrdersByStatus(status: Order['status']): Order[] {
    return this.getAllOrders({ status });
  }

  getTodaysOrders(): Order[] {
    const today = new Date().toISOString().split('T')[0];
    return this.getAllOrders({ fromDate: today });
  }

  private generateOrderNumber(): string {
    const today = new Date();
    const prefix = today.toISOString().slice(0, 10).replace(/-/g, '');
    const timestamp = Date.now().toString().slice(-6);
    return `ORD-${prefix}-${timestamp}`;
  }

  private mapRowToOrder(row: OrderRow): Order {
    const parsedItems = JSON.parse(row.items);

    return {
      id: row.id,
      order_number: row.order_number,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      customer_email: row.customer_email,
      items: parsedItems,
      total_amount: row.total_amount,
      status: row.status,
      order_type: row.order_type,
      table_number: row.table_number,
      delivery_address: row.delivery_address,
      delivery_notes: row.delivery_notes,
      delivery_floor: row.delivery_floor,
      delivery_city: row.delivery_city,
      delivery_postal_code: row.delivery_postal_code,
      name_on_ringer: row.name_on_ringer,
      special_instructions: row.special_instructions,
      created_at: row.created_at,
      updated_at: row.updated_at,
      estimated_time: row.estimated_time,
      supabase_id: row.supabase_id,
      sync_status: row.sync_status as 'synced' | 'pending' | 'failed',
      payment_status: row.payment_status,
      payment_method: row.payment_method,
      payment_transaction_id: row.payment_transaction_id,
      staff_shift_id: row.staff_shift_id,
      staff_id: row.staff_id,
      driver_id: row.driver_id,
      driver_name: row.driver_name,
      discount_percentage: row.discount_percentage,
      discount_amount: row.discount_amount,
      tip_amount: row.tip_amount,
      // Versioning and sync metadata
      version: row.version,
      updated_by: row.updated_by,
      last_synced_at: row.last_synced_at,
      remote_version: row.remote_version,
      // Plugin tracking
      plugin: row.plugin || undefined,
      external_plugin_order_id: row.external_plugin_order_id,
      plugin_commission_pct: row.plugin_commission_pct,
      net_earnings: row.net_earnings,
      terminal_id: row.terminal_id,
      // Backward compatibility
      platform: (row as any).platform,
      external_platform_order_id: (row as any).external_platform_order_id,
      platform_commission_pct: (row as any).platform_commission_pct
    };
  }

  // Update sync metadata after successful sync
  updateSyncMetadata(orderId: string, remoteVersion: number, lastSyncedAt: string): void {
    const stmt = this.db.prepare(`
      UPDATE orders
      SET remote_version = ?, last_synced_at = ?, sync_status = 'synced'
      WHERE id = ?
    `);
    stmt.run(remoteVersion, lastSyncedAt, orderId);
  }

  // Get order with sync info for conflict resolution
  getOrderWithSyncInfo(orderId: string): Order | null {
    return this.getOrder(orderId);
  }

  getOrdersByShift(shiftId: string): Order[] {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE staff_shift_id = ? ORDER BY created_at DESC');
    const rows = stmt.all(shiftId) as OrderRow[];
    return rows.map(row => this.mapRowToOrder(row));
  }

  /**
   * Maps a POS/local status to a Supabase-compatible status.
   * Ensures we never violate the orders_status_check constraint.
   */
  private mapStatusForSupabase(status: Order['status']): string {
    const SUPABASE_ALLOWED_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];

    if (status === 'out_for_delivery') return 'ready';
    if (status === 'delivered') return 'completed';
    if (SUPABASE_ALLOWED_STATUSES.includes(status)) return status;

    // Fallback for any unknown status
    return 'ready';
  }
}
