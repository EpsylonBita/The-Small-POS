/**
 * Centralized Supabase Configuration for POS System
 * Ensures consistent configuration across all services
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Desktop-specific client options
const DESKTOP_OPTIONS = {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  realtime: {
    params: {
      eventsPerSecond: 15,
    },
  },
};

// Safe accessor for process.env (not available in Vite browser runtime)
function getEnv(key: string): string | undefined {
  // Vite injects import.meta.env for VITE_* prefixed vars
  try {
    const meta = (import.meta as any).env;
    if (meta && meta[key]) return meta[key];
  } catch { /* not in a Vite context */ }
  // Node.js / Electron
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key];
  }
  return undefined;
}

// Get Supabase configuration from environment
export function getSupabaseConfig(platform: string = 'desktop') {
  const envUrl = runtimeSupabaseUrlOverride ||
                 getEnv('SUPABASE_URL') ||
                 getEnv('VITE_SUPABASE_URL') ||
                 getEnv('NEXT_PUBLIC_SUPABASE_URL');

  const envAnonKey = runtimeSupabaseAnonKeyOverride ||
                     getEnv('SUPABASE_ANON_KEY') ||
                     getEnv('VITE_SUPABASE_ANON_KEY') ||
                     getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');

  const envServiceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  const isElectron = typeof process !== 'undefined' && !!(process as any).versions?.electron;
  // SECURITY: Never expose service role key inside Electron (desktop) builds.
  const exposeServiceRoleKey = !!envServiceKey && !isElectron;

  return {
    url: envUrl || '',
    anonKey: envAnonKey || '',
    serviceRoleKey: exposeServiceRoleKey ? envServiceKey : undefined,
    options: DESKTOP_OPTIONS,
  };
}

// Lazy-load configuration to avoid crash at module load time
let _config: ReturnType<typeof getSupabaseConfig> | null = null;
let runtimeSupabaseUrlOverride: string | null = null;
let runtimeSupabaseAnonKeyOverride: string | null = null;

function normalizeRuntimeCredential(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

function getConfig() {
  if (!_config) {
    _config = getSupabaseConfig('desktop');
  }
  return _config;
}

function setRuntimeEnv(url: string, anonKey: string): void {
  // IMPORTANT: Do not mutate process.env here.
  // In webpack Electron bundles, DefinePlugin can inline selected process.env keys
  // (e.g. process.env.SUPABASE_URL) as literals, which breaks assignment expressions.
  runtimeSupabaseUrlOverride = url;
  runtimeSupabaseAnonKeyOverride = anonKey;
}

// Lazy SUPABASE_CONFIG getter
export const SUPABASE_CONFIG = {
  get url() { return getConfig().url; },
  get anonKey() { return getConfig().anonKey; },
} as const;

export interface SupabaseContext {
  terminalId?: string;
  organizationId?: string;
  branchId?: string;
  clientType?: string;
}

const storedContext: SupabaseContext = {};

function hydrateContextFromLocalStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    if (!storedContext.terminalId) {
      const tid = window.localStorage.getItem('terminal_id');
      if (tid) storedContext.terminalId = tid;
    }
    if (!storedContext.organizationId) {
      const oid = window.localStorage.getItem('organization_id');
      if (oid) storedContext.organizationId = oid;
    }
    if (!storedContext.branchId) {
      const bid = window.localStorage.getItem('branch_id');
      if (bid) storedContext.branchId = bid;
    }
  } catch {
    // Ignore storage access errors (e.g., blocked in some contexts)
  }
}

function buildGlobalHeaders(): Record<string, string> {
  return {
    'x-application-name': 'pos-system',
    'x-terminal-id': storedContext.terminalId || '',
    'x-organization-id': storedContext.organizationId || '',
    'x-branch-id': storedContext.branchId || '',
    'x-client-type': storedContext.clientType || 'desktop',
  };
}

export function setSupabaseContext(context: SupabaseContext): void {
  if (context.terminalId !== undefined) storedContext.terminalId = context.terminalId;
  if (context.organizationId !== undefined) storedContext.organizationId = context.organizationId;
  if (context.branchId !== undefined) storedContext.branchId = context.branchId;
  if (context.clientType !== undefined) storedContext.clientType = context.clientType;

  if (supabaseClient) {
    const headers = buildGlobalHeaders();
    (supabaseClient as any).headers = headers;
    if ((supabaseClient as any).rest) {
      (supabaseClient as any).rest.headers = headers;
    }
    if ((supabaseClient as any).storage) {
      (supabaseClient as any).storage.headers = headers;
    }
  }
}

// Check if configuration is available
export function isSupabaseConfigured(): boolean {
  const config = getConfig();
  return !!(config.url && config.anonKey && 
    config.url !== 'https://YOUR_PROJECT_REF.supabase.co' && 
    config.anonKey.length > 10);
}

let supabaseClient: SupabaseClient | null = null;

/**
 * Configure Supabase runtime credentials after startup.
 * Used when credentials are received from admin API during onboarding/sync.
 */
export function configureSupabaseRuntime(url: unknown, anonKey: unknown): boolean {
  const normalizedUrl = normalizeRuntimeCredential(url);
  const normalizedAnonKey = normalizeRuntimeCredential(anonKey);
  if (!normalizedUrl || !normalizedAnonKey) {
    return false;
  }

  setRuntimeEnv(normalizedUrl, normalizedAnonKey);
  _config = null;

  if (supabaseClient) {
    const config = getConfig();
    hydrateContextFromLocalStorage();
    supabaseClient = createClient(
      config.url || normalizedUrl,
      config.anonKey || normalizedAnonKey,
      {
        ...config.options,
        global: {
          headers: buildGlobalHeaders(),
        }
      }
    );
  }

  return true;
}

/**
 * Get or create the singleton Supabase client instance
 * Returns a client even if not fully configured (for onboarding flow)
 * The client will fail on actual API calls if not configured
 */
export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const config = getConfig();
    hydrateContextFromLocalStorage();
    // Create client even with empty/default values - it will fail gracefully on API calls
    // This allows the app to start and show onboarding
    supabaseClient = createClient(
      config.url || 'https://example.invalid',
      config.anonKey || 'placeholder-key',
      {
        ...config.options,
        global: {
          headers: buildGlobalHeaders(),
        }
      }
    );
  }
  
  return supabaseClient;
}

/**
 * Test Supabase connection
 */
export async function testSupabaseConnection(): Promise<{
  success: boolean;
  error?: string;
}> {
  if (!isSupabaseConfigured()) {
    return {
      success: false,
      error: 'Supabase not configured - please enter connection string in settings',
    };
  }
  
  try {
    const client = getSupabaseClient();
    const { error } = await client
      .from('orders')
      .select('count')
      .limit(1);
    
    if (error) {
      return {
        success: false,
        error: `Supabase connection test failed: ${error.message}`,
      };
    }
    
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Supabase connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Helper function to handle Supabase errors consistently
 */
export const handleSupabaseError = (error: any): string => {
  console.error('Supabase error:', error);

  if (error?.code === 'PGRST301') {
    return 'Resource not found';
  }

  if (error?.code === 'PGRST116') {
    return 'Invalid request parameters';
  }

  if (error?.code === '23505') {
    return 'This record already exists';
  }

  if (error?.code === '23503') {
    return 'Cannot delete this record as it is referenced by other data';
  }

  return error?.message || 'An unexpected error occurred';
};

// Export table names for consistency across platforms
export const SUPABASE_TABLES = {
  // Core business tables
  BRANCHES: 'branches',
  CUSTOMERS: 'customers',
  CUSTOMER_ADDRESSES: 'customer_addresses',
  ORDERS: 'orders',
  ORDER_ITEMS: 'order_items',
  MENU_CATEGORIES: 'menu_categories',
  MENU_ITEMS: 'subcategories',
  INGREDIENTS: 'ingredients',

  // POS system tables
  APP_CONTROL_COMMANDS: 'app_control_commands',
  POS_TERMINALS: 'pos_terminals',
  POS_HEARTBEATS: 'pos_heartbeats',
  POS_CONFIGURATIONS: 'pos_configurations',
  POS_SETTINGS_SYNC_HISTORY: 'pos_settings_sync_history',

  // Admin configuration tables
  WEB_CONFIGURATIONS: 'web_configurations',
  APP_CONFIGURATIONS_ENHANCED: 'app_configurations_enhanced',
  PUSH_NOTIFICATION_SETTINGS: 'push_notification_settings',

  // Analytics tables
  USER_ANALYTICS: 'user_analytics',
  DELIVERY_ZONE_ANALYTICS: 'delivery_zone_analytics',

  // Auth and user management
  PROFILES: 'profiles',
  USER_PROFILES: 'user_profiles',
  ROLES: 'roles',
  STAFF: 'staff',
} as const;

export default getSupabaseClient; 
