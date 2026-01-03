/**
 * POS-to-Admin API Synchronization Helpers
 *
 * This module provides utility functions for the POS system to call
 * the admin dashboard sync endpoints for tables, reservations, suppliers, and analytics.
 */

import { DatabaseManager } from './database';

// Configuration - reads from local settings first, then env, then fallback
const getBaseUrl = (db?: DatabaseManager): string => {
  // Try to get stored URL from local settings
  if (db) {
    try {
      const dbSvc = db.getDatabaseService?.();
      if (dbSvc?.settings) {
        const storedUrl = dbSvc.settings.getSetting('terminal', 'admin_dashboard_url', null) as string | null;
        if (storedUrl) {
          return storedUrl.replace(/\/$/, '');
        }
      }
    } catch (e) {
      console.warn('[api-sync] Failed to load stored admin URL:', e);
    }
  }
  return (process.env.ADMIN_DASHBOARD_URL || 'http://localhost:3001').replace(/\/$/, '');
};

// Types for API responses
export interface TableFromAdmin {
  id: string;
  table_number: number;
  capacity: number;
  status: 'available' | 'occupied' | 'reserved' | 'cleaning';
  branch_id: string;
  position_x?: number;
  position_y?: number;
  shape?: 'rectangle' | 'circle' | 'square' | 'custom';
  notes?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ReservationFromAdmin {
  id: string;
  customer_name: string;
  customer_phone: string;
  customer_email?: string;
  party_size: number;
  reservation_datetime: string;
  duration_minutes: number;
  status: 'pending' | 'confirmed' | 'seated' | 'completed' | 'no_show' | 'cancelled';
  table_id?: string;
  branch_id: string;
  special_requests?: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ReservationStats {
  total: number;
  pending: number;
  confirmed: number;
  seated: number;
  completed: number;
  no_show: number;
  cancelled: number;
}

export interface SupplierFromAdmin {
  id: string;
  name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface AnalyticsFromAdmin {
  section?: string;
  time_range?: string;
  data: Record<string, unknown>;
}

// Filter options
export interface FetchTablesOptions {
  status?: 'available' | 'occupied' | 'reserved' | 'cleaning';
  capacity_min?: number;
  capacity_max?: number;
}

export interface FetchReservationsOptions {
  date_from?: string;
  date_to?: string;
  status?: 'pending' | 'confirmed' | 'seated' | 'completed' | 'no_show' | 'cancelled';
  search?: string;
  party_size?: number;
  table_id?: string;
}

export interface FetchSuppliersOptions {
  is_active?: boolean;
  search?: string;
}

export interface FetchAnalyticsOptions {
  time_range?: '24h' | '7d' | '30d' | '90d' | '1y';
  section?: string;
}

export interface FetchOrdersOptions {
  status?: string;
  order_type?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface OrderFromAdmin {
  id: string;
  order_number: string;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  items: any[];
  total_amount: number;
  status: string;
  order_type?: string;
  payment_method?: string;
  payment_status?: string;
  delivery_address?: string;
  delivery_city?: string;
  delivery_postal_code?: string;
  delivery_floor?: string;
  delivery_notes?: string;
  table_number?: string;
  special_instructions?: string;
  name_on_ringer?: string;
  driver_id?: string;
  driver_name?: string;
  staff_id?: string;
  staff_shift_id?: string;
  branch_id?: string;
  terminal_id?: string;
  subtotal?: number;
  tax_amount?: number;
  delivery_fee?: number;
  discount_amount?: number;
  tip_amount?: number;
  created_at: string;
  updated_at: string;
  estimated_ready_time?: number;
}

/**
 * Resolve terminal settings from database or environment
 * Persisted settings (from connection string) take priority over env vars
 */
async function resolveTerminalSettings(db: DatabaseManager): Promise<{
  terminalId: string;
  apiKey: string;
}> {
  let terminalId = 'terminal-001';
  let apiKey = '';

  // Try persisted settings first (from connection string)
  try {
    const storedTid = await db.getSetting('terminal' as any, 'terminal_id', '');
    if (storedTid && typeof storedTid === 'string' && storedTid.trim()) {
      terminalId = storedTid.trim();
    }
  } catch {
    // fallback to env/default
  }

  // Only use env var if no persisted setting
  if (terminalId === 'terminal-001' && process.env.TERMINAL_ID) {
    terminalId = process.env.TERMINAL_ID;
  }

  try {
    const key = await db.getSetting('terminal' as any, 'pos_api_key', '');
    if (key && typeof key === 'string' && key.trim()) {
      apiKey = key.trim();
    }
  } catch {
    // ignore, treat as missing API key
  }

  console.log(`[POS API Sync] resolveTerminalSettings:`, {
    terminalId,
    hasApiKey: !!apiKey,
    apiKeyLength: apiKey?.length || 0,
    apiKeyPreview: apiKey ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : '(not set)'
  });

  return { terminalId, apiKey };
}

/**
 * Build request headers for admin API calls
 */
function buildHeaders(terminalId: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-terminal-id': terminalId,
  };

  const adminToken = process.env.ADMIN_API_TOKEN || process.env.ADMIN_DASHBOARD_TOKEN;
  if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
  if (apiKey) headers['x-pos-api-key'] = apiKey;

  return headers;
}

/**
 * Make a fetch request with timeout and error handling
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  context: string
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error(`[POS API Sync] ${context}: Request timed out after 10s`);
      throw new Error(`${context}: Request timed out`);
    }
    console.error(`[POS API Sync] ${context}: Network error`, { error: error?.message });
    throw new Error(`${context}: Network error - ${error?.message || 'Unknown'}`);
  }
}

/**
 * Parse API response and handle errors
 */
async function parseApiResponse<T>(
  response: Response,
  context: string
): Promise<T> {
  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      // ignore
    }
    console.error(`[POS API Sync] ${context}: API error`, {
      status: response.status,
      errorBody,
    });
    throw new Error(`${context}: API error (${response.status}) - ${errorBody || 'Unknown'}`);
  }

  try {
    const json = await response.json();
    if (json.success === false) {
      throw new Error(`${context}: ${json.error || 'Request failed'}`);
    }
    return json;
  } catch (error: any) {
    if (error.message.includes(context)) throw error;
    console.error(`[POS API Sync] ${context}: Failed to parse response`, { error: error?.message });
    throw new Error(`${context}: Failed to parse response`);
  }
}

/**
 * Build query string from options object
 */
function buildQueryString(options: FetchTablesOptions | FetchReservationsOptions | FetchSuppliersOptions | FetchAnalyticsOptions | Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== null && value !== '') {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Fetch tables from admin dashboard
 */
export async function fetchTablesFromAdmin(
  db: DatabaseManager,
  options?: FetchTablesOptions
): Promise<TableFromAdmin[]> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const queryString = buildQueryString(options || {});
  const url = `${base}/api/pos/tables${queryString}`;

  console.log(`[POS API Sync] fetchTablesFromAdmin: Fetching tables`, { terminalId, url });

  const response = await fetchWithTimeout(url, { method: 'GET', headers }, 'fetchTablesFromAdmin');
  const data = await parseApiResponse<{ success: boolean; tables: TableFromAdmin[] }>(
    response,
    'fetchTablesFromAdmin'
  );

  console.log(`[POS API Sync] fetchTablesFromAdmin: Success`, { count: data.tables?.length || 0 });
  return data.tables || [];
}

/**
 * Fetch reservations from admin dashboard
 */
export async function fetchReservationsFromAdmin(
  db: DatabaseManager,
  options?: FetchReservationsOptions
): Promise<{ reservations: ReservationFromAdmin[]; stats: ReservationStats }> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const queryString = buildQueryString(options || {});
  const url = `${base}/api/pos/reservations${queryString}`;

  console.log(`[POS API Sync] fetchReservationsFromAdmin: Fetching reservations`, { terminalId, url });

  const response = await fetchWithTimeout(url, { method: 'GET', headers }, 'fetchReservationsFromAdmin');
  const data = await parseApiResponse<{
    success: boolean;
    reservations: ReservationFromAdmin[];
    stats: ReservationStats;
  }>(response, 'fetchReservationsFromAdmin');

  console.log(`[POS API Sync] fetchReservationsFromAdmin: Success`, {
    count: data.reservations?.length || 0,
  });
  return {
    reservations: data.reservations || [],
    stats: data.stats || { total: 0, pending: 0, confirmed: 0, seated: 0, completed: 0, no_show: 0, cancelled: 0 },
  };
}

/**
 * Fetch suppliers from admin dashboard
 */
export async function fetchSuppliersFromAdmin(
  db: DatabaseManager,
  options?: FetchSuppliersOptions
): Promise<SupplierFromAdmin[]> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const queryString = buildQueryString(options || {});
  const url = `${base}/api/pos/suppliers${queryString}`;

  console.log(`[POS API Sync] fetchSuppliersFromAdmin: Fetching suppliers`, { terminalId, url });

  const response = await fetchWithTimeout(url, { method: 'GET', headers }, 'fetchSuppliersFromAdmin');
  const data = await parseApiResponse<{ success: boolean; suppliers: SupplierFromAdmin[] }>(
    response,
    'fetchSuppliersFromAdmin'
  );

  console.log(`[POS API Sync] fetchSuppliersFromAdmin: Success`, { count: data.suppliers?.length || 0 });
  return data.suppliers || [];
}

/**
 * Fetch analytics from admin dashboard
 */
export async function fetchAnalyticsFromAdmin(
  db: DatabaseManager,
  options?: FetchAnalyticsOptions
): Promise<AnalyticsFromAdmin> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const queryString = buildQueryString(options || {});
  const url = `${base}/api/pos/analytics${queryString}`;

  console.log(`[POS API Sync] fetchAnalyticsFromAdmin: Fetching analytics`, { terminalId, url });

  const response = await fetchWithTimeout(url, { method: 'GET', headers }, 'fetchAnalyticsFromAdmin');
  const data = await parseApiResponse<{ success: boolean; analytics?: AnalyticsFromAdmin; data?: Record<string, unknown> }>(
    response,
    'fetchAnalyticsFromAdmin'
  );

  console.log(`[POS API Sync] fetchAnalyticsFromAdmin: Success`);
  return data.analytics || { data: data.data || {} };
}

/**
 * Fetch all orders from admin dashboard
 * This fetches orders from Supabase through the admin dashboard API
 * Used for the Orders Page to display all historical orders
 */
export async function fetchOrdersFromAdmin(
  db: DatabaseManager,
  options?: FetchOrdersOptions
): Promise<{ orders: OrderFromAdmin[]; total: number }> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const queryString = buildQueryString(options || {});
  const url = `${base}/api/pos/orders${queryString}`;

  console.log(`[POS API Sync] fetchOrdersFromAdmin: Fetching orders`, {
    terminalId,
    url,
    options,
    hasApiKey: !!apiKey,
    apiKeyLength: apiKey?.length || 0,
    headers: {
      'x-terminal-id': headers['x-terminal-id'],
      'x-pos-api-key': apiKey ? `${apiKey.substring(0, 8)}...` : '(missing)'
    }
  });

  const response = await fetchWithTimeout(url, { method: 'GET', headers }, 'fetchOrdersFromAdmin');
  const data = await parseApiResponse<{ success: boolean; orders: OrderFromAdmin[]; total?: number }>(
    response,
    'fetchOrdersFromAdmin'
  );

  console.log(`[POS API Sync] fetchOrdersFromAdmin: Success`, { count: data.orders?.length || 0, total: data.total || 0 });
  return {
    orders: data.orders || [],
    total: data.total || data.orders?.length || 0
  };
}

