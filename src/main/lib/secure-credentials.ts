/**
 * Secure Credentials Management
 *
 * SECURITY: Stores sensitive credentials in OS keychain instead of bundled in code
 * Uses keytar to interface with:
 * - Windows: Credential Manager
 * - macOS: Keychain
 * - Linux: Secret Service API / libsecret
 */

import * as keytar from 'keytar';

const SERVICE_NAME = 'the-small-pos-system';

export interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

/**
 * Store Supabase credentials securely in OS keychain
 */
export async function storeSupabaseCredentials(url: string, anonKey: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, 'supabase-url', url);
    await keytar.setPassword(SERVICE_NAME, 'supabase-anon-key', anonKey);
    console.log('[SecureCredentials] Supabase credentials stored securely');
  } catch (error) {
    console.error('[SecureCredentials] Failed to store credentials:', error);
    throw new Error('Failed to store credentials securely');
  }
}

/**
 * Retrieve Supabase credentials from OS keychain
 * Falls back to environment variables if not found in keychain
 */
export async function getSupabaseCredentials(): Promise<SupabaseCredentials> {
  try {
    // Try to get from keychain first
    let url = await keytar.getPassword(SERVICE_NAME, 'supabase-url');
    let anonKey = await keytar.getPassword(SERVICE_NAME, 'supabase-anon-key');

    // Fallback to environment variables (for initial setup or migration)
    if (!url || !anonKey) {
      console.log('[SecureCredentials] Credentials not in keychain, checking environment variables');
      url = process.env.SUPABASE_URL || null;
      anonKey = process.env.SUPABASE_ANON_KEY || null;

      // If found in env, migrate to keychain
      if (url && anonKey) {
        console.log('[SecureCredentials] Migrating credentials from env to keychain');
        await storeSupabaseCredentials(url, anonKey);
      }
    }

    if (!url || !anonKey) {
      throw new Error('Supabase credentials not configured');
    }

    return { url, anonKey };
  } catch (error) {
    console.error('[SecureCredentials] Failed to retrieve credentials:', error);
    throw new Error('Failed to retrieve Supabase credentials');
  }
}

/**
 * Check if credentials are configured
 */
export async function hasSupabaseCredentials(): Promise<boolean> {
  try {
    const url = await keytar.getPassword(SERVICE_NAME, 'supabase-url');
    const anonKey = await keytar.getPassword(SERVICE_NAME, 'supabase-anon-key');
    return !!(url && anonKey) || !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
  } catch (error) {
    return false;
  }
}

/**
 * Delete stored credentials (for reset/reconfiguration)
 */
export async function deleteSupabaseCredentials(): Promise<void> {
  try {
    await keytar.deletePassword(SERVICE_NAME, 'supabase-url');
    await keytar.deletePassword(SERVICE_NAME, 'supabase-anon-key');
    console.log('[SecureCredentials] Credentials deleted from keychain');
  } catch (error) {
    console.error('[SecureCredentials] Failed to delete credentials:', error);
  }
}

/**
 * Store Google API key securely
 */
export async function storeGoogleApiKey(apiKey: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, 'google-api-key', apiKey);
    console.log('[SecureCredentials] Google API key stored securely');
  } catch (error) {
    console.error('[SecureCredentials] Failed to store Google API key:', error);
  }
}

/**
 * Retrieve Google API key
 */
export async function getGoogleApiKey(): Promise<string | null> {
  try {
    let apiKey = await keytar.getPassword(SERVICE_NAME, 'google-api-key');

    // Fallback to environment variable
    if (!apiKey) {
      apiKey = process.env.GOOGLE_MAPS_API_KEY || null;

      // Migrate to keychain if found in env
      if (apiKey) {
        await storeGoogleApiKey(apiKey);
      }
    }

    return apiKey;
  } catch (error) {
    console.error('[SecureCredentials] Failed to retrieve Google API key:', error);
    return process.env.GOOGLE_MAPS_API_KEY || null;
  }
}
