// Consolidated Order Types for POS System
// Shared between main and renderer processes

export type OrderStatus = 'pending' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered' | 'completed' | 'cancelled';
export type OrderType = 'dine-in' | 'pickup' | 'delivery';
export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
export type PaymentMethod = 'cash' | 'card' | 'digital';
export type SyncStatus = 'synced' | 'pending' | 'failed';

/** Order plugin - where the order originated from */
export type OrderPlugin =
  | 'pos'           // In-store POS system
  | 'web'           // Customer web app
  | 'android-ios'   // Customer mobile app
  | 'wolt'          // Wolt delivery plugin
  | 'efood'         // E-food delivery plugin
  | 'box'           // Box delivery plugin
  | 'uber_eats'     // Uber Eats
  | 'booking'       // Booking.com
  | 'tripadvisor'   // TripAdvisor
  | 'airbnb';       // Airbnb

/**
 * @deprecated Use OrderPlugin instead
 */
export type OrderPlatform = OrderPlugin;

// Order item options interface
export interface OrderItemOption {
  id: string;
  name: string;
  value: string | number | boolean;
  price?: number;
  category?: string;
}

// Customer type for tiered pricing
export type CustomerType = 'retail' | 'wholesale' | 'member';

// Order item interface
export interface OrderItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  unit_price?: number;
  total_price?: number;
  original_unit_price?: number | null;
  is_price_overridden?: boolean;
  notes?: string;
  special_instructions?: string; // For backward compatibility
  options?: OrderItemOption[];
  customizations?: any[];
  // Tiered pricing tracking
  originalPrice?: number; // Original retail price before tier discount
  appliedPriceType?: CustomerType; // Which price tier was applied
  priceTierLabel?: string; // Human-readable tier label (e.g., "Wholesale (min 10)")
}

// Order pricing breakdown
export interface OrderPricing {
  subtotal: number;
  deliveryFee: number;
  pickupDiscount: number;
  serviceFee: number;
  taxAmount: number;
  totalAmount: number;
  deliveryZoneId?: string | null;
  deliveryZoneName?: string | null;
  pricingCalculatedAt?: string | null;
  pricingVersion?: string | null;
  estimatedTime?: {
    min: number;
    max: number;
    message: string;
  } | null;
}

// Main Order interface - consolidated from all sources
export interface Order {
  id: string;
  order_number?: string;
  orderNumber: string; // Required for renderer compatibility
  status: OrderStatus;
  cancellation_reason?: string; // snake_case for storage compatibility
  cancellationReason?: string; // Reason for cancellation
  items: OrderItem[];
  total_amount: number;
  totalAmount: number; // Required for renderer compatibility

  // Customer information
  customer_name?: string;
  customerName?: string; // For backward compatibility
  customer_phone?: string;
  customerPhone?: string; // For backward compatibility
  customer_email?: string | null; // Allow null for compatibility
  customer_id?: string | null; // Allow null for compatibility

  // Order details
  order_type?: OrderType;
  orderType: OrderType; // Required for renderer compatibility
  table_number?: string | null; // Allow null for compatibility
  tableNumber?: string; // For backward compatibility
  delivery_address?: string | null; // Allow null for compatibility
  delivery_city?: string | null; // City for delivery address
  delivery_postal_code?: string | null; // Postal code for delivery address
  delivery_floor?: string | null; // Floor for delivery address
  delivery_notes?: string | null; // Notes for delivery address
  name_on_ringer?: string | null; // Name on the ringer/doorbell
  address?: string; // For backward compatibility
  special_instructions?: string;
  notes?: string; // For backward compatibility

  // Timestamps
  created_at: string;
  createdAt: string; // Required for renderer compatibility
  updated_at: string;
  updatedAt: string; // Required for renderer compatibility

  // Timing
  estimated_time?: number; // in minutes
  estimatedTime?: number; // For backward compatibility

  // Payment information
  payment_status?: PaymentStatus;
  paymentStatus?: PaymentStatus; // For backward compatibility
  payment_method?: PaymentMethod;
  paymentMethod?: PaymentMethod; // For backward compatibility
  payment_transaction_id?: string;
  paymentTransactionId?: string; // For backward compatibility

  // Discount information
  discount_percentage?: number; // Discount percentage (0-100)
  discount_amount?: number; // Calculated discount amount in currency
  manual_discount_mode?: 'percentage' | 'fixed' | null;
  manual_discount_value?: number | null;
  coupon_id?: string | null;
  coupon_code?: string | null;
  coupon_discount_amount?: number | null;
  couponId?: string | null;
  couponCode?: string | null;
  couponDiscountAmount?: number | null;
  is_ghost?: boolean;
  ghost_source?: string | null;
  ghost_metadata?: Record<string, unknown> | null;

  // Driver information (for delivery orders)
  driver_id?: string; // Assigned driver for delivery orders
  driverId?: string; // For backward compatibility
  driverName?: string; // Driver name for display

  // Preparation tracking
  preparationProgress?: number; // 0-100 percentage

  // Sync information
  supabase_id?: string;
  sync_status?: SyncStatus;
  syncStatus?: SyncStatus; // For backward compatibility
  version?: number; // For optimistic locking
  updatedBy?: string; // User who last updated
  lastSyncedAt?: string; // Last sync timestamp
  terminal_id?: string | null;
  terminalId?: string | null; // For backward compatibility
  branch_id?: string | null;
  branchId?: string | null; // For backward compatibility

  // Enhanced pricing breakdown
  pricing?: OrderPricing;
  subtotal?: number;
  deliveryFee?: number;
  pickupDiscount?: number;
  serviceFee?: number;
  tax_amount?: number; // snake_case for storage compatibility
  taxAmount?: number;
  tax?: number; // legacy fallback
  deliveryZoneId?: string | null;
  pricingCalculatedAt?: string | null;
  pricingVersion?: string | null;

  // Plugin tracking (for external plugin orders like Wolt, Efood, etc.)
  plugin?: OrderPlugin | string; // Plugin where order originated (e.g., 'wolt', 'efood', 'pos')
  order_plugin?: OrderPlugin | string; // Alternative field name for plugin
  external_plugin_order_id?: string; // Original order ID from external plugin
  plugin_commission_pct?: number; // Commission percentage charged by plugin
  net_earnings?: number; // Net earnings after plugin commission deduction

  // Backward compatibility - @deprecated
  platform?: string; // @deprecated Use plugin instead
  order_platform?: string; // @deprecated Use order_plugin instead
  external_platform_order_id?: string; // @deprecated Use external_plugin_order_id instead
  platform_commission_pct?: number; // @deprecated Use plugin_commission_pct instead

  // Hybrid Sync Routing information
  routing_path?: string; // 'main', 'via_parent', 'direct_cloud'
  source_terminal_id?: string;
  forwarded_at?: string;
}

// Database row interface for SQLite
export interface OrderRow {
  id: string;
  order_number?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  items: string; // JSON string
  total_amount: number;
  tax_amount?: number;
  status: OrderStatus;
  cancellation_reason?: string;
  order_type?: OrderType;
  table_number?: string;
  delivery_address?: string;
  delivery_city?: string;
  delivery_postal_code?: string;
  delivery_floor?: string;
  delivery_notes?: string;
  name_on_ringer?: string;
  special_instructions?: string;
  created_at: string;
  updated_at: string;
  estimated_time?: number;
  supabase_id?: string;
  sync_status: SyncStatus;
  payment_status?: PaymentStatus;
  payment_method?: string;
  payment_transaction_id?: string;
  discount_percentage?: number;
  discount_amount?: number;
  manual_discount_mode?: 'percentage' | 'fixed' | null;
  manual_discount_value?: number | null;
  coupon_id?: string | null;
  coupon_code?: string | null;
  coupon_discount_amount?: number | null;
  is_ghost?: boolean;
  ghost_source?: string | null;
  ghost_metadata?: string | null;
  driver_id?: string;
  terminal_id?: string | null;
  branch_id?: string | null;
  // Plugin tracking
  plugin?: OrderPlugin | string;
  external_plugin_order_id?: string;
  plugin_commission_pct?: number;
  net_earnings?: number;
  // Backward compatibility - @deprecated
  platform?: string;
  external_platform_order_id?: string;
  platform_commission_pct?: number;
  // Hybrid Sync Routing information
  routing_path?: string;
  source_terminal_id?: string;
  forwarded_at?: string;
}

// Order filters for queries
export interface OrderFilters {
  status?: OrderStatus;
  date?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
  customer_id?: string;
  order_type?: OrderType;
}

// Order creation parameters
export interface OrderCreateParams {
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  customer_id?: string;
  items: OrderItem[];
  total_amount: number;
  order_type?: OrderType;
  table_number?: string;
  delivery_address?: string;
  delivery_city?: string;
  delivery_postal_code?: string;
  delivery_floor?: string;
  delivery_notes?: string;
  name_on_ringer?: string;
  special_instructions?: string;
  discount_percentage?: number;
  discount_amount?: number;
  manual_discount_mode?: 'percentage' | 'fixed' | null;
  manual_discount_value?: number | null;
  coupon_id?: string | null;
  coupon_code?: string | null;
  coupon_discount_amount?: number | null;
  is_ghost?: boolean;
  ghost_source?: string | null;
  ghost_metadata?: Record<string, unknown> | null;
  estimated_time?: number;
  payment_method?: PaymentMethod;
  payment_transaction_id?: string;
}

// Order update parameters
export interface OrderUpdateParams {
  status?: OrderStatus;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  items?: OrderItem[];
  total_amount?: number;
  order_type?: OrderType;
  table_number?: string;
  delivery_address?: string;
  delivery_city?: string;
  delivery_postal_code?: string;
  delivery_floor?: string;
  delivery_notes?: string;
  name_on_ringer?: string;
  special_instructions?: string;
  discount_percentage?: number;
  discount_amount?: number;
  manual_discount_mode?: 'percentage' | 'fixed' | null;
  manual_discount_value?: number | null;
  coupon_id?: string | null;
  coupon_code?: string | null;
  coupon_discount_amount?: number | null;
  is_ghost?: boolean;
  ghost_source?: string | null;
  ghost_metadata?: Record<string, unknown> | null;
  estimated_time?: number;
  payment_status?: PaymentStatus;
  payment_method?: PaymentMethod;
  payment_transaction_id?: string;
}
