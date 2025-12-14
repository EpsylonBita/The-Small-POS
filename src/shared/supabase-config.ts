/**
 * Centralized Supabase Configuration for POS System
 * Ensures consistent configuration across all services
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from '../../../shared/config/supabase-config';

// Export getSupabaseConfig for use in other parts of the POS system
export { getSupabaseConfig };

// Lazy-load configuration to avoid crash at module load time
let _config: ReturnType<typeof getSupabaseConfig> | null = null;
function getConfig() {
  if (!_config) {
    _config = getSupabaseConfig('desktop');
  }
  return _config;
}

// Lazy SUPABASE_CONFIG getter
export const SUPABASE_CONFIG = {
  get url() { return getConfig().url; },
  get anonKey() { return getConfig().anonKey; },
} as const;

// Check if configuration is available
export function isSupabaseConfigured(): boolean {
  const config = getConfig();
  return !!(config.url && config.anonKey && 
    config.url !== 'https://YOUR_PROJECT_REF.supabase.co' && 
    config.anonKey.length > 10);
}

let supabaseClient: SupabaseClient | null = null;

/**
 * Get or create the singleton Supabase client instance
 * Returns a client even if not fully configured (for onboarding flow)
 * The client will fail on actual API calls if not configured
 */
export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const config = getConfig();
    // Create client even with empty/default values - it will fail gracefully on API calls
    // This allows the app to start and show onboarding
    supabaseClient = createClient(
      config.url || 'https://placeholder.supabase.co', 
      config.anonKey || 'placeholder-key',
      {
        ...config.options,
        global: {
          headers: {
            'x-application-name': 'pos-system',
          }
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

export default getSupabaseClient; 