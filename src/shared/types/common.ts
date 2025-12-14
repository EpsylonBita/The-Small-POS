// Common types shared across the POS system

export interface SystemInfo {
  platform: string;
  version: string;
  arch: string;
  appVersion: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  offset?: number;
}

export interface PaginatedResponse<T = any> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface SortParams {
  field: string;
  direction: 'asc' | 'desc';
}

export interface FilterParams {
  [key: string]: any;
}

export interface SearchParams {
  query?: string;
  filters?: FilterParams;
  sort?: SortParams;
  pagination?: PaginationParams;
}

// Generic database entity interface
export interface BaseEntity {
  id: string;
  created_at: string;
  updated_at: string;
}

// Generic service response
export interface ServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

// Environment configuration
export interface EnvironmentConfig {
  NODE_ENV: string;
  ADMIN_DASHBOARD_URL: string;
  ADMIN_API_BASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  PAYMENT_MODE: 'test' | 'production';
  PAYMENT_TEST_CARDS_ENABLED: boolean;
  DEBUG_LOGGING: boolean;
}
