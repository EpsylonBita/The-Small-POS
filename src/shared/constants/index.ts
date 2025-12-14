// Application Constants for POS System
// Centralized constants to avoid magic numbers and improve maintainability

// Timing Constants
export const TIMING = {
  // Session timeouts (in milliseconds)
  SESSION_TIMEOUT: 30 * 60 * 1000, // 30 minutes
  ACTIVITY_CHECK_INTERVAL: 60 * 1000, // 1 minute

  // Sync intervals
  AUTO_SYNC_INTERVAL: 5 * 60 * 1000, // 5 minutes
  HEARTBEAT_INTERVAL: 30 * 1000, // 30 seconds

  // UI timeouts
  TOAST_DURATION: 3000, // 3 seconds
  LOADING_TIMEOUT: 10 * 1000, // 10 seconds
  DEBOUNCE_DELAY: 300, // 300ms

  // Order timing
  DEFAULT_ESTIMATED_TIME: 15, // 15 minutes
  MAX_ESTIMATED_TIME: 120, // 2 hours

  // Retry intervals
  RETRY_BASE_DELAY: 1000, // 1 second
  RETRY_MAX_DELAY: 30 * 1000, // 30 seconds
  MAX_RETRY_ATTEMPTS: 3,

  // Database timeouts
  DATABASE_INIT_TIMEOUT: 15000, // 15 seconds for database initialization
  DATABASE_QUERY_TIMEOUT: 15000, // 15 seconds for individual queries (increased for slow connections)

  // API timeouts
  SUPABASE_REQUEST_TIMEOUT: 15000, // 15 seconds for Supabase API calls
  CUSTOMER_LOOKUP_TIMEOUT: 10000, // 10 seconds for customer lookup
  MENU_LOAD_TIMEOUT: 15000, // 15 seconds for menu data loading
  ORDER_CREATE_TIMEOUT: 15000, // 15 seconds for order creation
} as const;

// UI Constants
export const UI = {
  // Touch targets (in pixels)
  TOUCH_TARGET_MIN: 44,
  TOUCH_TARGET_COMFORTABLE: 48,
  TOUCH_TARGET_LARGE: 56,
  
  // Grid and layout
  GRID_COLUMNS_MOBILE: 1,
  GRID_COLUMNS_TABLET: 2,
  GRID_COLUMNS_DESKTOP: 3,
  
  // Animation durations (in milliseconds)
  ANIMATION_FAST: 150,
  ANIMATION_NORMAL: 300,
  ANIMATION_SLOW: 500,
  
  // Z-index layers
  Z_INDEX: {
    DROPDOWN: 1000,
    STICKY: 1020,
    FIXED: 1030,
    MODAL_BACKDROP: 1040,
    MODAL: 1050,
    POPOVER: 1060,
    TOOLTIP: 1070,
    TOAST: 1080,
  },
} as const;

// Business Logic Constants
export const BUSINESS = {
  // Order limits
  MAX_ORDER_ITEMS: 50,
  MIN_ORDER_AMOUNT: 0.01,
  MAX_ORDER_AMOUNT: 9999.99,
  
  // Customer limits
  MAX_CUSTOMER_NAME_LENGTH: 100,
  MAX_PHONE_LENGTH: 20,
  MAX_ADDRESS_LENGTH: 500,
  MAX_NOTES_LENGTH: 1000,
  
  // Pricing
  DEFAULT_TAX_RATE: 0.1, // 10%
  DEFAULT_SERVICE_FEE: 0.05, // 5%
  MIN_DELIVERY_FEE: 0,
  MAX_DELIVERY_FEE: 50,
  
  // Inventory
  MAX_QUANTITY_PER_ITEM: 99,
  LOW_STOCK_THRESHOLD: 10,
} as const;

// Database Constants
export const DATABASE = {
  // Connection settings
  CONNECTION_TIMEOUT: 5000, // 5 seconds
  QUERY_TIMEOUT: 30000, // 30 seconds
  
  // Pagination
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  
  // Sync settings
  SYNC_BATCH_SIZE: 50,
  MAX_SYNC_RETRIES: 5,
  SYNC_CLEANUP_DAYS: 30,
  
  // Backup settings
  BACKUP_RETENTION_DAYS: 7,
  AUTO_BACKUP_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
} as const;

// API Constants
export const API = {
  // Request timeouts
  REQUEST_TIMEOUT: 10000, // 10 seconds
  UPLOAD_TIMEOUT: 60000, // 1 minute
  
  // Rate limiting
  MAX_REQUESTS_PER_MINUTE: 60,
  RATE_LIMIT_WINDOW: 60 * 1000, // 1 minute
  
  // Response codes
  HTTP_STATUS: {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE_ENTITY: 422,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
  },
} as const;

// File System Constants
export const FILES = {
  // File size limits (in bytes)
  MAX_IMAGE_SIZE: 5 * 1024 * 1024, // 5MB
  MAX_DOCUMENT_SIZE: 10 * 1024 * 1024, // 10MB
  
  // Supported formats
  SUPPORTED_IMAGE_FORMATS: ['jpg', 'jpeg', 'png', 'webp'] as const,
  SUPPORTED_DOCUMENT_FORMATS: ['pdf', 'doc', 'docx', 'txt'] as const,
  
  // Paths
  TEMP_DIR: 'tmp',
  BACKUP_DIR: 'backups',
  LOGS_DIR: 'logs',
} as const;

// Security Constants
export const SECURITY = {
  // Password requirements
  MIN_PASSWORD_LENGTH: 8,
  MAX_PASSWORD_LENGTH: 128,
  
  // PIN requirements
  PIN_LENGTH: 4,
  MAX_PIN_ATTEMPTS: 3,
  PIN_LOCKOUT_DURATION: 15 * 60 * 1000, // 15 minutes
  
  // Session security
  MAX_CONCURRENT_SESSIONS: 5,
  SESSION_ROTATION_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
  
  // Encryption
  SALT_ROUNDS: 12,
  TOKEN_LENGTH: 32,
} as const;

// Error Messages
export const ERROR_MESSAGES = {
  // Generic errors
  UNKNOWN_ERROR: 'An unexpected error occurred',
  GENERIC_ERROR: 'An error occurred',
  NETWORK_ERROR: 'Network connection error',
  TIMEOUT_ERROR: 'Request timed out',

  // Authentication errors
  INVALID_CREDENTIALS: 'Invalid username or password',
  SESSION_EXPIRED: 'Your session has expired',
  ACCESS_DENIED: 'Access denied',

  // Validation errors
  REQUIRED_FIELD: 'This field is required',
  INVALID_EMAIL: 'Please enter a valid email address',
  INVALID_PHONE: 'Please enter a valid phone number',

  // Business logic errors
  ORDER_NOT_FOUND: 'Order not found',
  INSUFFICIENT_STOCK: 'Insufficient stock available',
  PAYMENT_FAILED: 'Payment processing failed',

  // Database errors
  DATABASE_INIT_FAILED: 'Failed to initialize database',
  DATABASE_CONNECTION_LOST: 'Database connection lost',
  DATABASE_QUERY_FAILED: 'Database query failed',

  // Timeout errors
  OPERATION_TIMEOUT: 'Operation timed out',
  DATABASE_TIMEOUT: 'Database operation timed out',
  NETWORK_TIMEOUT: 'Network request timed out',

  // Service errors
  MENU_LOAD_FAILED: 'Failed to load menu data',
  CUSTOMER_LOOKUP_FAILED: 'Failed to lookup customer',
  ORDER_CREATE_FAILED: 'Failed to create order',

  // Recovery messages
  RETRY_OPERATION: 'Please try again',
  CHECK_CONNECTION: 'Please check your internet connection',
  CONTACT_SUPPORT: 'Please contact support if the problem persists',
} as const;

// Success Messages
export const SUCCESS_MESSAGES = {
  ORDER_CREATED: 'Order created successfully',
  ORDER_UPDATED: 'Order updated successfully',
  ORDER_CANCELLED: 'Order cancelled successfully',
  PAYMENT_PROCESSED: 'Payment processed successfully',
  SYNC_COMPLETED: 'Data synchronized successfully',
  BACKUP_CREATED: 'Backup created successfully',
} as const;

// Retry Constants
export const RETRY = {
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 1000,
  EXPONENTIAL_BACKOFF: true,
} as const;

// Feature Flags
export const FEATURES = {
  ENABLE_OFFLINE_MODE: true,
  ENABLE_REAL_TIME_SYNC: true,
  ENABLE_PAYMENT_PROCESSING: true,
  ENABLE_INVENTORY_TRACKING: true,
  ENABLE_CUSTOMER_MANAGEMENT: true,
  ENABLE_REPORTING: true,
  ENABLE_MULTI_LANGUAGE: false,
  ENABLE_DARK_MODE: true,
} as const;

// POS Module Registry
export {
  POS_IMPLEMENTED_MODULES,
  POS_COMING_SOON_MODULES,
  isModuleImplemented,
  isModuleComingSoon,
  shouldShowInNavigation,
} from './pos-modules';
