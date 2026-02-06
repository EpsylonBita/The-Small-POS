/**
 * POS System Supabase Integration
 *
 * MIGRATION PLAN:
 * - Old functions (syncSettings, syncMenuItems, syncDeliveryZones) are DEPRECATED
 * - Use new Ex-suffixed functions (syncSettingsEx, syncMenuItemsEx, syncDeliveryZonesEx)
 * - New functions return { success, data, error } for better error handling
 * - Old functions will be removed in v2.0
 *
 * FEATURES:
 * - Connection status tracking via connectionStatus export
 * - Automatic retry with exponential backoff for network errors
 * - Health check via testConnection()
 * - Granular error messages (network vs auth vs database)
 */

import { getSupabaseClient, handleSupabaseError, isSupabaseConfigured } from './supabase-config';

// Re-export the client for backward compatibility (lazy via Proxy to keep headers fresh)
export const supabase = new Proxy({} as ReturnType<typeof getSupabaseClient>, {
  get(_target, prop) {
    const client = getSupabaseClient() as any;
    const value = client[prop as keyof typeof client];
    return typeof value === 'function' ? value.bind(client) : value;
  }
}) as ReturnType<typeof getSupabaseClient>;

// Export configuration check
export { isSupabaseConfigured };

// Re-export error handler for backward compatibility
export { handleSupabaseError } from './supabase-config';

// Connection status tracking
export const connectionStatus = {
  connected: false,
  lastSync: null as Date | null,
  lastError: ''
};

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 1,
  initialDelay: 1000, // 1 second
  backoffMultiplier: 2
};

/**
 * Test connection to Supabase
 */
export async function testConnection(): Promise<{ success: boolean; latency?: number; error?: string }> {
  const startTime = Date.now();
  try {
    const { error } = await supabase.from('roles').select('id').limit(1);
    const latency = Date.now() - startTime;

    if (error) {
      connectionStatus.connected = false;
      connectionStatus.lastError = error.message;

      // Categorize error
      if (error.message.includes('JWT') || error.message.includes('auth')) {
        return { success: false, error: `Authentication error: ${error.message}` };
      } else if (error.message.includes('relation') || error.message.includes('does not exist')) {
        return { success: false, error: `Database error: Table missing or inaccessible` };
      } else {
        return { success: false, error: `Network error: ${error.message}` };
      }
    }

    connectionStatus.connected = true;
    connectionStatus.lastError = '';
    return { success: true, latency };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    connectionStatus.connected = false;
    connectionStatus.lastError = errorMessage;
    return { success: false, error: `Network error: ${errorMessage}` };
  }
}

/**
 * Retry helper with exponential backoff
 * Does not retry on authentication errors
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  isAuthError: (error: any) => boolean
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on authentication errors
      if (isAuthError(error)) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === RETRY_CONFIG.maxRetries) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      const delay = RETRY_CONFIG.initialDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// Helper function to check if user is authenticated
export const checkAuth = async () => {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession()

  if (error) {
    console.error('Auth check error:', error)
    return null
  }

  return session
}

// Helper function to sign out
export const signOut = async () => {
  const { error } = await supabase.auth.signOut()

  if (error) {
    console.error('Sign out error:', error)
    throw error
  }
}

// Real-time subscription helper
export const subscribeToTable = (
  table: string,
  callback: (payload: any) => void,
  filter?: string
) => {
  const channel = supabase
    .channel(`${table}_changes`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        filter,
      },
      callback
    )
    .subscribe()

  return channel
}

// Unsubscribe from real-time updates
export const unsubscribeFromChannel = (channel: any) => {
  supabase.removeChannel(channel)
}

// ============================================================================
// NEW API - Use these functions for better error handling
// ============================================================================

/**
 * Sync POS settings with enhanced error handling
 * @returns {success, data, error} - Status object with data or error message
 */
export async function syncSettingsEx(): Promise<{ success: boolean; data: any | null; error?: string }> {
  try {
    const result = await retryWithBackoff(
      async () => {
        const { data, error } = await supabase
          .from('pos_configurations')
          .select('*')
          .single();

        if (error) throw error;
        return data;
      },
      (error) => error?.message?.includes('JWT') || error?.message?.includes('auth')
    );

    connectionStatus.connected = true;
    connectionStatus.lastSync = new Date();
    connectionStatus.lastError = '';

    return { success: true, data: result };
  } catch (error: any) {
    connectionStatus.connected = false;
    connectionStatus.lastError = error?.message || 'Unknown error';

    // Categorize error
    let errorMessage = 'Failed to sync settings';
    if (error?.message?.includes('JWT') || error?.message?.includes('auth')) {
      errorMessage = 'Authentication error: Invalid or expired credentials';
    } else if (error?.message?.includes('relation') || error?.message?.includes('does not exist')) {
      errorMessage = 'Database error: pos_configurations table not found';
    } else if (error?.message?.includes('network') || error?.message?.includes('fetch')) {
      errorMessage = 'Network error: Unable to connect to server';
    } else {
      errorMessage = `Settings sync error: ${error?.message || 'Unknown error'}`;
    }

    return { success: false, data: null, error: errorMessage };
  }
}

/**
 * Sync menu items with enhanced error handling
 * @returns {success, data, error} - Status object with data or error message
 */
export async function syncMenuItemsEx(): Promise<{ success: boolean; data: any[] | null; error?: string }> {
  try {
    const result = await retryWithBackoff(
      async () => {
        const { data, error } = await supabase
          .from('subcategories')
          .select(`
            *,
            category:menu_categories (*),
            customizations:subcategory_customizations (*)
          `)
          .eq('is_available', true);

        if (error) throw error;
        return data || [];
      },
      (error) => error?.message?.includes('JWT') || error?.message?.includes('auth')
    );

    connectionStatus.connected = true;
    connectionStatus.lastSync = new Date();
    connectionStatus.lastError = '';

    return { success: true, data: result };
  } catch (error: any) {
    connectionStatus.connected = false;
    connectionStatus.lastError = error?.message || 'Unknown error';

    // Categorize error
    let errorMessage = 'Failed to sync menu items';
    if (error?.message?.includes('JWT') || error?.message?.includes('auth')) {
      errorMessage = 'Authentication error: Invalid or expired credentials';
    } else if (error?.message?.includes('relation') || error?.message?.includes('does not exist')) {
      errorMessage = 'Database error: subcategories table not found';
    } else if (error?.message?.includes('network') || error?.message?.includes('fetch')) {
      errorMessage = 'Network error: Unable to connect to server';
    } else {
      errorMessage = `Menu sync error: ${error?.message || 'Unknown error'}`;
    }

    return { success: false, data: null, error: errorMessage };
  }
}

/**
 * Sync delivery zones with enhanced error handling
 * @returns {success, data, error} - Status object with data or error message
 */
export async function syncDeliveryZonesEx(): Promise<{ success: boolean; data: any[] | null; error?: string }> {
  try {
    const result = await retryWithBackoff(
      async () => {
        const { data, error } = await supabase
          .from('delivery_zones')
          .select('*')
          .eq('active', true);

        if (error) throw error;
        return data || [];
      },
      (error) => error?.message?.includes('JWT') || error?.message?.includes('auth')
    );

    connectionStatus.connected = true;
    connectionStatus.lastSync = new Date();
    connectionStatus.lastError = '';

    return { success: true, data: result };
  } catch (error: any) {
    connectionStatus.connected = false;
    connectionStatus.lastError = error?.message || 'Unknown error';

    // Categorize error
    let errorMessage = 'Failed to sync delivery zones';
    if (error?.message?.includes('JWT') || error?.message?.includes('auth')) {
      errorMessage = 'Authentication error: Invalid or expired credentials';
    } else if (error?.message?.includes('relation') || error?.message?.includes('does not exist')) {
      errorMessage = 'Database error: delivery_zones table not found';
    } else if (error?.message?.includes('network') || error?.message?.includes('fetch')) {
      errorMessage = 'Network error: Unable to connect to server';
    } else {
      errorMessage = `Delivery zones sync error: ${error?.message || 'Unknown error'}`;
    }

    return { success: false, data: null, error: errorMessage };
  }
}

// ============================================================================
// DEPRECATED API - Use Ex-suffixed functions instead
// These will be removed in v2.0
// ============================================================================

/**
 * @deprecated Use syncSettingsEx() instead. Returns null on error instead of status object.
 */
export const syncSettings = async () => {
  const result = await syncSettingsEx();
  if (!result.success) {
    console.error('Settings sync error:', result.error);
    return null;
  }
  return result.data;
}

/**
 * @deprecated Use syncMenuItemsEx() instead. Returns [] on error instead of status object.
 */
export const syncMenuItems = async () => {
  const result = await syncMenuItemsEx();
  if (!result.success) {
    console.error('Menu sync error:', result.error);
    return [];
  }
  return result.data || [];
}

/**
 * @deprecated Use syncDeliveryZonesEx() instead. Returns [] on error instead of status object.
 */
export const syncDeliveryZones = async () => {
  const result = await syncDeliveryZonesEx();
  if (!result.success) {
    console.error('Delivery zones sync error:', result.error);
    return [];
  }
  return result.data || [];
}

export default supabase
