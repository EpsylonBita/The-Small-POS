/**
 * Secure Credentials Management
 *
 * SECURITY: Stores sensitive credentials using Electron's built-in safeStorage API
 * - Windows: DPAPI (Data Protection API)
 * - macOS: Keychain
 * - Linux: libsecret (with fallback to encrypted file)
 *
 * Migration from keytar (archived Dec 2022) to safeStorage (actively maintained)
 */

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const CREDENTIALS_FILE = 'credentials.enc';

interface CredentialsStore {
  'supabase-url'?: string;
  'supabase-anon-key'?: string;
  'google-api-key'?: string;
  'terminal-pos-api-key'?: string;
  _migrated?: boolean;
}

export interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

/**
 * Get the path to the encrypted credentials file
 */
function getCredentialsPath(): string {
  return path.join(app.getPath('userData'), CREDENTIALS_FILE);
}

/**
 * Read encrypted credentials from file
 */
function readCredentialsFile(): CredentialsStore {
  try {
    const credPath = getCredentialsPath();
    if (!fs.existsSync(credPath)) {
      return {};
    }

    const encryptedBuffer = fs.readFileSync(credPath);
    if (encryptedBuffer.length === 0) {
      return {};
    }

    // Check if encryption is available
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[SecureCredentials] Encryption not available, credentials may not be secure');
      // On Linux without keyring, try to read as plain JSON (fallback)
      try {
        return JSON.parse(encryptedBuffer.toString('utf8'));
      } catch {
        return {};
      }
    }

    const decrypted = safeStorage.decryptString(encryptedBuffer);
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('[SecureCredentials] Failed to read credentials file:', error);
    return {};
  }
}

/**
 * Write encrypted credentials to file
 */
function writeCredentialsFile(store: CredentialsStore): void {
  try {
    const credPath = getCredentialsPath();
    const json = JSON.stringify(store);

    // Check if encryption is available
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[SecureCredentials] Encryption not available, storing credentials (less secure)');
      // On Linux without keyring, store as plain JSON (fallback)
      fs.writeFileSync(credPath, json, 'utf8');
      return;
    }

    const encrypted = safeStorage.encryptString(json);
    fs.writeFileSync(credPath, encrypted);
  } catch (error) {
    console.error('[SecureCredentials] Failed to write credentials file:', error);
    throw new Error('Failed to store credentials securely');
  }
}

/**
 * Get a single credential value
 */
function getCredential(key: keyof CredentialsStore): string | null {
  const store = readCredentialsFile();
  return (store[key] as string) || null;
}

/**
 * Set a single credential value
 */
function setCredential(key: keyof CredentialsStore, value: string): void {
  const store = readCredentialsFile();
  (store as Record<string, string | boolean | undefined>)[key] = value;
  writeCredentialsFile(store);
}

/**
 * Delete a single credential value
 */
function deleteCredential(key: keyof CredentialsStore): void {
  const store = readCredentialsFile();
  delete store[key];
  writeCredentialsFile(store);
}

/**
 * Migrate credentials from keytar to safeStorage (one-time)
 * This runs once and marks migration as complete
 */
export async function migrateFromKeytar(): Promise<void> {
  try {
    const store = readCredentialsFile();

    // Already migrated
    if (store._migrated) {
      return;
    }

    // Try to import keytar dynamically (may not be available after removal)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let keytar: any = null;
    try {
      keytar = require('keytar');
    } catch {
      console.log('[SecureCredentials] keytar not available, skipping migration');
      // Mark as migrated even if keytar not available
      store._migrated = true;
      writeCredentialsFile(store);
      return;
    }

    const SERVICE_NAME = 'the-small-pos-system';
    let migrated = false;

    // Migrate supabase-url
    const url = await keytar.getPassword(SERVICE_NAME, 'supabase-url');
    if (url && !store['supabase-url']) {
      store['supabase-url'] = url;
      migrated = true;
      console.log('[SecureCredentials] Migrated supabase-url from keytar');
    }

    // Migrate supabase-anon-key
    const anonKey = await keytar.getPassword(SERVICE_NAME, 'supabase-anon-key');
    if (anonKey && !store['supabase-anon-key']) {
      store['supabase-anon-key'] = anonKey;
      migrated = true;
      console.log('[SecureCredentials] Migrated supabase-anon-key from keytar');
    }

    // Migrate google-api-key
    const googleKey = await keytar.getPassword(SERVICE_NAME, 'google-api-key');
    if (googleKey && !store['google-api-key']) {
      store['google-api-key'] = googleKey;
      migrated = true;
      console.log('[SecureCredentials] Migrated google-api-key from keytar');
    }

    // Mark migration as complete
    store._migrated = true;
    writeCredentialsFile(store);

    if (migrated) {
      console.log('[SecureCredentials] Migration from keytar completed successfully');

      // Clean up keytar entries (optional - remove after testing)
      try {
        await keytar.deletePassword(SERVICE_NAME, 'supabase-url');
        await keytar.deletePassword(SERVICE_NAME, 'supabase-anon-key');
        await keytar.deletePassword(SERVICE_NAME, 'google-api-key');
        console.log('[SecureCredentials] Cleaned up old keytar entries');
      } catch (e) {
        console.warn('[SecureCredentials] Failed to clean up keytar entries:', e);
      }
    }
  } catch (error) {
    console.error('[SecureCredentials] Migration from keytar failed:', error);
  }
}

/**
 * Store Supabase credentials securely
 */
export async function storeSupabaseCredentials(url: string, anonKey: string): Promise<void> {
  try {
    const store = readCredentialsFile();
    store['supabase-url'] = url;
    store['supabase-anon-key'] = anonKey;
    writeCredentialsFile(store);
    console.log('[SecureCredentials] Supabase credentials stored securely');
  } catch (error) {
    console.error('[SecureCredentials] Failed to store credentials:', error);
    throw new Error('Failed to store credentials securely');
  }
}

/**
 * Retrieve Supabase credentials
 * Falls back to environment variables if not found in secure storage
 */
export async function getSupabaseCredentials(): Promise<SupabaseCredentials> {
  try {
    // Try to get from secure storage first
    let url = getCredential('supabase-url');
    let anonKey = getCredential('supabase-anon-key');

    // Fallback to environment variables (for initial setup or migration)
    if (!url || !anonKey) {
      console.log('[SecureCredentials] Credentials not in secure storage, checking environment variables');
      url = process.env.SUPABASE_URL || null;
      anonKey = process.env.SUPABASE_ANON_KEY || null;

      // If found in env, migrate to secure storage
      if (url && anonKey) {
        console.log('[SecureCredentials] Migrating credentials from env to secure storage');
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
    const url = getCredential('supabase-url');
    const anonKey = getCredential('supabase-anon-key');
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
    const store = readCredentialsFile();
    delete store['supabase-url'];
    delete store['supabase-anon-key'];
    writeCredentialsFile(store);
    console.log('[SecureCredentials] Credentials deleted from secure storage');
  } catch (error) {
    console.error('[SecureCredentials] Failed to delete credentials:', error);
  }
}

/**
 * Store Google API key securely
 */
export async function storeGoogleApiKey(apiKey: string): Promise<void> {
  try {
    setCredential('google-api-key', apiKey);
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
    let apiKey = getCredential('google-api-key');

    // Fallback to environment variable
    if (!apiKey) {
      apiKey = process.env.GOOGLE_MAPS_API_KEY || null;

      // Migrate to secure storage if found in env
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

/**
 * Store terminal POS API key securely.
 * This is the credential used for admin-dashboard POS API authentication.
 */
export function storeTerminalApiKey(apiKey: string): void {
  try {
    setCredential('terminal-pos-api-key', apiKey);
  } catch (error) {
    console.error('[SecureCredentials] Failed to store terminal POS API key:', error);
  }
}

/**
 * Retrieve terminal POS API key from secure storage.
 */
export function getTerminalApiKey(): string | null {
  try {
    return getCredential('terminal-pos-api-key');
  } catch (error) {
    console.error('[SecureCredentials] Failed to retrieve terminal POS API key:', error);
    return null;
  }
}

/**
 * Delete terminal POS API key from secure storage.
 */
export function deleteTerminalApiKey(): void {
  try {
    deleteCredential('terminal-pos-api-key');
  } catch (error) {
    console.error('[SecureCredentials] Failed to delete terminal POS API key:', error);
  }
}

/**
 * Check if safeStorage encryption is available
 */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/**
 * Get the storage backend being used (Linux only)
 */
export function getStorageBackend(): string {
  if (process.platform === 'linux') {
    return safeStorage.getSelectedStorageBackend();
  }
  return process.platform === 'darwin' ? 'keychain' : 'dpapi';
}
