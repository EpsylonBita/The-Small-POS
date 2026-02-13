/**
 * POS-to-Admin API Synchronization Helpers
 *
 * This module provides utility functions for the POS system to call
 * the admin dashboard sync endpoints for tables, reservations, suppliers, and analytics.
 */

import { DatabaseManager } from './database';

function normalizeAdminDashboardUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';

  let normalized = trimmed;
  if (!/^https?:\/\//i.test(normalized)) {
    const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(normalized);
    normalized = `${isLocalhost ? 'http' : 'https'}://${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    parsed.search = '';
    parsed.hash = '';
    const cleanPath = parsed.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
    parsed.pathname = cleanPath || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return normalized.replace(/\/+$/, '').replace(/\/api$/i, '');
  }
}

function extractAdminUrlFromConnectionString(posApiKey: string): string {
  const trimmed = (posApiKey || '').trim();
  if (!trimmed || trimmed.length < 20) return '';

  try {
    const base64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    return normalizeAdminDashboardUrl((parsed?.url || '').toString());
  } catch {
    return '';
  }
}

function isLocalhostAdminUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname);
  } catch {
    return /(?:^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i.test(url);
  }
}

// Configuration - reads from terminal settings first, then env (explicit), then fallback
const getBaseUrl = (db?: DatabaseManager): string => {
  let storedAdminUrl = '';
  let legacyAdminUrl = '';
  let terminalId = '';
  let apiKey = '';
  let dbSvc: ReturnType<DatabaseManager['getDatabaseService']> | undefined;

  if (db) {
    try {
      dbSvc = db.getDatabaseService?.();
      if (dbSvc?.settings) {
        storedAdminUrl = (dbSvc.settings.getSetting('terminal', 'admin_dashboard_url', '') || '').toString();
        legacyAdminUrl = (dbSvc.settings.getSetting('terminal', 'admin_url', '') || '').toString();
        terminalId = (dbSvc.settings.getSetting('terminal', 'terminal_id', '') || '').toString();
        apiKey = (dbSvc.settings.getSetting('terminal', 'pos_api_key', '') || '').toString();
      }
    } catch (e) {
      console.warn('[api-sync] Failed to load terminal settings for admin URL resolution:', e);
    }
  }

  let adminUrl = normalizeAdminDashboardUrl(storedAdminUrl) || normalizeAdminDashboardUrl(legacyAdminUrl);

  if (!adminUrl && apiKey) {
    const decodedUrl = extractAdminUrlFromConnectionString(apiKey);
    if (decodedUrl) {
      adminUrl = decodedUrl;
      try {
        dbSvc?.settings?.setSetting?.('terminal', 'admin_dashboard_url', decodedUrl);
      } catch (persistError) {
        console.warn('[api-sync] Failed to persist decoded admin dashboard URL:', persistError);
      }
    }
  }

  const rawEnvAdminUrl = (process.env.ADMIN_DASHBOARD_URL || process.env.ADMIN_API_BASE_URL || '').trim();
  const envAdminUrl = normalizeAdminDashboardUrl(rawEnvAdminUrl);

  if (!adminUrl && envAdminUrl) {
    const hasTerminalCredentials = !!apiKey && !!terminalId && terminalId !== 'terminal-001';
    if (hasTerminalCredentials && isLocalhostAdminUrl(envAdminUrl)) {
      throw new Error(
        'Admin dashboard URL is missing for this terminal. Update terminal.admin_dashboard_url in Connection Settings.'
      );
    }
    adminUrl = envAdminUrl;
  }

  if (adminUrl) {
    return adminUrl;
  }

  // Development bootstrap fallback only (before terminal credentials are configured)
  const hasTerminalCredentials = !!apiKey && !!terminalId && terminalId !== 'terminal-001';
  if (hasTerminalCredentials) {
    throw new Error(
      'Admin dashboard URL is not configured for this terminal. Save a valid Admin Dashboard URL and retry sync.'
    );
  }

  return 'http://localhost:3001';
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

// Room filter options (Hotel Vertical)
export interface FetchRoomsOptions {
  status?: RoomStatus;
  floor?: number;
  room_type?: RoomType;
}

// Room types (Hotel Vertical) - forward declarations for use in FetchRoomsOptions
export type RoomStatus = 'available' | 'occupied' | 'maintenance' | 'cleaning' | 'reserved';
export type RoomType = 'standard' | 'deluxe' | 'suite' | 'penthouse' | 'accessible';

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

  // SECURITY: Do not log API key content.
  console.log(`[POS API Sync] resolveTerminalSettings:`, {
    terminalId,
    hasApiKey: !!apiKey,
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
function buildQueryString(options: FetchTablesOptions | FetchReservationsOptions | FetchSuppliersOptions | FetchAnalyticsOptions | FetchOrdersOptions | FetchRoomsOptions | FetchDriveThruOptions | Record<string, unknown>): string {
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

  // SECURITY: Do not log API key content.
  console.log(`[POS API Sync] fetchOrdersFromAdmin: Fetching orders`, {
    terminalId,
    url,
    options,
    hasApiKey: !!apiKey,
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

export interface RoomFromAdmin {
  id: string;
  room_number: string;
  floor: number;
  room_type: RoomType;
  status: RoomStatus;
  branch_id: string;
  organization_id: string;
  capacity?: number;
  rate_per_night?: number;
  amenities?: string[];
  notes?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Fetch rooms from admin dashboard
 * Uses the POS rooms API endpoint instead of direct Supabase access
 */
export async function fetchRoomsFromAdmin(
  db: DatabaseManager,
  options?: FetchRoomsOptions
): Promise<RoomFromAdmin[]> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const queryString = buildQueryString(options || {});
  const url = `${base}/api/pos/rooms${queryString}`;

  console.log(`[POS API Sync] fetchRoomsFromAdmin: Fetching rooms`, { terminalId, url });

  const response = await fetchWithTimeout(url, { method: 'GET', headers }, 'fetchRoomsFromAdmin');
  const data = await parseApiResponse<{ success: boolean; rooms: RoomFromAdmin[] }>(
    response,
    'fetchRoomsFromAdmin'
  );

  console.log(`[POS API Sync] fetchRoomsFromAdmin: Success`, { count: data.rooms?.length || 0 });
  return data.rooms || [];
}

/**
 * Update room status via admin dashboard API
 * Uses the POS rooms API endpoint instead of direct Supabase access
 */
export async function updateRoomStatusFromAdmin(
  db: DatabaseManager,
  roomId: string,
  status: RoomStatus
): Promise<RoomFromAdmin> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const url = `${base}/api/pos/rooms/${roomId}`;

  console.log(`[POS API Sync] updateRoomStatusFromAdmin: Updating room`, { terminalId, roomId, status });

  const response = await fetchWithTimeout(
    url,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status }),
    },
    'updateRoomStatusFromAdmin'
  );
  const data = await parseApiResponse<{ success: boolean; room: RoomFromAdmin }>(
    response,
    'updateRoomStatusFromAdmin'
  );

  console.log(`[POS API Sync] updateRoomStatusFromAdmin: Success`, { roomId, status });
  return data.room;
}

// ============================================================================
// ORDER SYNC API
// ============================================================================

export interface OrderSyncOperation {
  operation: 'insert' | 'update';
  client_order_id: string;
  data: Record<string, unknown>;
  items?: OrderSyncItem[];
}

export interface OrderSyncItem {
  id?: string;
  menu_item_id: string;
  menu_item_name?: string | null;
  quantity: number;
  unit_price: number;
  total_price?: number;
  customizations?: Record<string, unknown> | null;
  notes?: string | null;
}

export interface OrderSyncResult {
  client_order_id: string;
  success: boolean;
  supabase_id?: string;
  order_number?: string;
  error?: string;
  operation: 'insert' | 'update';
}

export interface BatchSyncResponse {
  success: boolean;
  results: OrderSyncResult[];
  sync_timestamp: string;
  processed_count: number;
  success_count: number;
  error_count: number;
}

export interface IncrementalSyncResponse {
  success: boolean;
  orders: OrderFromAdmin[];
  deleted_ids: string[];
  sync_timestamp: string;
  total_count: number;
  has_more: boolean;
}

/**
 * Batch sync orders to admin dashboard via authenticated API.
 * This is the preferred method for syncing orders as it:
 * - Uses per-terminal API keys (no service role key needed)
 * - Provides better security (keys are rotatable without app update)
 * - Includes server-side validation and audit logging
 *
 * @param db - Database manager for reading terminal settings
 * @param operations - Array of sync operations (insert/update)
 * @returns Promise with batch sync results
 */
export async function syncOrdersToAdmin(
  db: DatabaseManager,
  operations: OrderSyncOperation[]
): Promise<BatchSyncResponse> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const url = `${base}/api/pos/orders/sync`;

  console.log(`[POS API Sync] syncOrdersToAdmin: Syncing ${operations.length} orders`, {
    terminalId,
    url,
    hasApiKey: !!apiKey,
    operationCount: operations.length,
  });

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ operations }),
    },
    'syncOrdersToAdmin'
  );

  const data = await parseApiResponse<BatchSyncResponse>(response, 'syncOrdersToAdmin');

  console.log(`[POS API Sync] syncOrdersToAdmin: Completed`, {
    processedCount: data.processed_count,
    successCount: data.success_count,
    errorCount: data.error_count,
  });

  return data;
}

/**
 * Fetch order updates from admin dashboard since a given timestamp.
 * Used for incremental sync to pull changes made by other terminals or admin.
 *
 * @param db - Database manager for reading terminal settings
 * @param options - Sync options including 'since' timestamp
 * @returns Promise with orders updated since timestamp and any deleted IDs
 */
export async function fetchOrderUpdatesFromAdmin(
  db: DatabaseManager,
  options?: {
    since?: string;
    limit?: number;
    include_deleted?: boolean;
  }
): Promise<IncrementalSyncResponse> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const queryString = buildQueryString(options || {});
  const url = `${base}/api/pos/orders/sync${queryString}`;

  console.log(`[POS API Sync] fetchOrderUpdatesFromAdmin: Fetching updates`, {
    terminalId,
    url,
    since: options?.since,
    limit: options?.limit,
  });

  const response = await fetchWithTimeout(url, { method: 'GET', headers }, 'fetchOrderUpdatesFromAdmin');
  const data = await parseApiResponse<IncrementalSyncResponse>(response, 'fetchOrderUpdatesFromAdmin');

  console.log(`[POS API Sync] fetchOrderUpdatesFromAdmin: Success`, {
    orderCount: data.orders?.length || 0,
    deletedCount: data.deleted_ids?.length || 0,
    hasMore: data.has_more,
  });

  return data;
}

/**
 * Sync a single order to admin dashboard.
 * Convenience wrapper around syncOrdersToAdmin for single-order operations.
 *
 * @param db - Database manager
 * @param operation - The operation type ('insert' or 'update')
 * @param clientOrderId - The local order ID
 * @param data - Order data
 * @param items - Optional order items for insert operations
 * @returns Promise with sync result
 */
export async function syncSingleOrderToAdmin(
  db: DatabaseManager,
  operation: 'insert' | 'update',
  clientOrderId: string,
  data: Record<string, unknown>,
  items?: OrderSyncItem[]
): Promise<OrderSyncResult> {
  const result = await syncOrdersToAdmin(db, [{
    operation,
    client_order_id: clientOrderId,
    data,
    items,
  }]);

  if (result.results && result.results.length > 0) {
    return result.results[0];
  }

  return {
    client_order_id: clientOrderId,
    success: false,
    error: 'Empty response from server',
    operation,
  };
}

// ============================================================================
// DRIVE-THROUGH SYNC API
// ============================================================================

export interface DriveThruLaneFromAdmin {
  id: string;
  lane_number: number;
  name: string;
  is_active: boolean;
  current_order_id: string | null;
  branch_id: string;
  organization_id: string;
  created_at: string;
  updated_at: string;
}

export interface DriveThruOrderFromAdmin {
  id: string;
  order_id: string;
  order_number: string | null;
  order_status: string | null;
  order_total: number;
  customer_name: string | null;
  lane_id: string;
  lane_number: number | null;
  lane_name: string | null;
  position: number;
  status: string;
  arrived_at: string;
  served_at: string | null;
  wait_time_seconds: number | null;
  created_at: string;
  updated_at: string;
}

export interface DriveThruQueueStats {
  total_in_queue: number;
  by_status: {
    waiting: number;
    preparing: number;
    ready: number;
  };
  lanes_count: number;
}

export interface FetchDriveThruOptions {
  lane_id?: string;
  status?: string;
}

export interface FetchDriveThruResponse {
  success: boolean;
  lanes: DriveThruLaneFromAdmin[];
  orders: DriveThruOrderFromAdmin[];
  queue_stats: DriveThruQueueStats;
}

export interface UpdateDriveThruOrderResponse {
  success: boolean;
  drive_through_order: DriveThruOrderFromAdmin;
}

/**
 * Fetch drive-through lanes and orders from admin dashboard
 * Uses the POS drive-through API endpoint for proper auth & audit logging
 */
export async function fetchDriveThruFromAdmin(
  db: DatabaseManager,
  options?: FetchDriveThruOptions
): Promise<FetchDriveThruResponse> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const queryString = buildQueryString(options || {});
  const url = `${base}/api/pos/drive-through${queryString}`;

  console.log(`[POS API Sync] fetchDriveThruFromAdmin: Fetching drive-through data`, { terminalId, url });

  const response = await fetchWithTimeout(url, { method: 'GET', headers }, 'fetchDriveThruFromAdmin');
  const data = await parseApiResponse<FetchDriveThruResponse>(response, 'fetchDriveThruFromAdmin');

  console.log(`[POS API Sync] fetchDriveThruFromAdmin: Success`, {
    lanesCount: data.lanes?.length || 0,
    ordersCount: data.orders?.length || 0,
  });

  return data;
}

/**
 * Update drive-through order status via admin dashboard API
 */
export async function updateDriveThruOrderStatusFromAdmin(
  db: DatabaseManager,
  driveThruOrderId: string,
  status: string
): Promise<DriveThruOrderFromAdmin> {
  const base = getBaseUrl(db);
  const { terminalId, apiKey } = await resolveTerminalSettings(db);
  const headers = buildHeaders(terminalId, apiKey);
  const url = `${base}/api/pos/drive-through`;

  console.log(`[POS API Sync] updateDriveThruOrderStatusFromAdmin: Updating order`, {
    terminalId,
    driveThruOrderId,
    status,
  });

  const response = await fetchWithTimeout(
    url,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        drive_through_order_id: driveThruOrderId,
        status,
      }),
    },
    'updateDriveThruOrderStatusFromAdmin'
  );

  const data = await parseApiResponse<UpdateDriveThruOrderResponse>(
    response,
    'updateDriveThruOrderStatusFromAdmin'
  );

  console.log(`[POS API Sync] updateDriveThruOrderStatusFromAdmin: Success`, {
    driveThruOrderId,
    status,
  });

  return data.drive_through_order;
}
