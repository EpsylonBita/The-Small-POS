/**
 * Shared Constants (POS-local stub)
 */

export const TIMING = {
  // API timeouts
  API_TIMEOUT: 10000,
  API_TIMEOUT_MS: 10000,
  SYNC_TIMEOUT: 30000,
  SYNC_TIMEOUT_MS: 30000,
  DATABASE_QUERY_TIMEOUT: 5000,
  DATABASE_INIT_TIMEOUT: 10000,
  ORDER_CREATE_TIMEOUT: 15000,
  MENU_LOAD_TIMEOUT: 10000,
  
  // Retry settings
  RETRY_DELAY: 1000,
  RETRY_DELAY_MS: 1000,
  MAX_RETRIES: 3,
  
  // Debounce settings
  DEBOUNCE_MS: 300,
  SEARCH_DEBOUNCE_MS: 500,
  
  // Cache settings
  CACHE_TTL_MS: 5 * 60 * 1000, // 5 minutes
  
  // Health check
  HEALTH_CHECK_INTERVAL_MS: 60000, // 1 minute
} as const;

export const RETRY = {
  MAX_RETRIES: 3,
  MAX_RETRY_ATTEMPTS: 3,
  INITIAL_DELAY_MS: 1000,
  RETRY_DELAY_MS: 1000,
  MAX_DELAY_MS: 10000,
  BACKOFF_MULTIPLIER: 2,
} as const;

export const ORDER_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PREPARING: 'preparing',
  READY: 'ready',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
} as const;

export const ORDER_TYPES = {
  DINE_IN: 'dine_in',
  TAKEAWAY: 'takeaway',
  DELIVERY: 'delivery',
  PICKUP: 'pickup',
} as const;

export const API = {
  TIMEOUT: 10000,
  TIMEOUT_MS: 10000,
} as const;

export const ERROR_MESSAGES = {
  NETWORK_ERROR: 'Network error occurred',
  TIMEOUT_ERROR: 'Request timed out',
  AUTH_ERROR: 'Authentication failed',
  VALIDATION_ERROR: 'Validation failed',
  UNKNOWN_ERROR: 'An unexpected error occurred',
  GENERIC_ERROR: 'An error occurred. Please try again.',
} as const;
