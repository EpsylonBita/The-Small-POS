// Re-export order types from shared types for backward compatibility
// This ensures consistency across the entire application
export type {
  OrderStatus,
  OrderType,
  PaymentStatus,
  PaymentMethod,
  CustomerType,
  Order,
  OrderItem,
  OrderItemOption,
  OrderPricing,
  OrderRow,
  OrderFilters,
  OrderCreateParams,
  OrderUpdateParams
} from '../../shared/types/orders';