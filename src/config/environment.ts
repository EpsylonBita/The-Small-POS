// Environment configuration service for POS system
import { getSupabaseClient, SUPABASE_CONFIG } from '../shared/supabase-config';

// Window interface for electron API
interface WindowWithElectronAPI {
  electronAPI?: any;
  electron?: {
    ipcRenderer?: {
      invoke: (channel: string, ...args: any[]) => Promise<any>;
    };
  };
}

export interface EnvironmentConfig {
  NODE_ENV: string;
  ADMIN_DASHBOARD_URL: string;
  ADMIN_API_BASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  PAYMENT_MODE: 'test' | 'production';
  PAYMENT_TEST_CARDS_ENABLED: boolean;
  DEBUG_LOGGING: boolean;
  POS_API_SHARED_KEY: string;
  POS_API_KEY: string;
  TERMINAL_ID: string;
}

// Get environment variable with fallback
function getEnvVar(key: string, fallback: string = ''): string {
  // Check process.env first (main process)
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key] || fallback;
  }

  // Check window environment (renderer process)
  if (typeof window !== 'undefined') {
    const windowWithElectron = window as WindowWithElectronAPI & Window;
    if (windowWithElectron.electronAPI && windowWithElectron.electronAPI.getEnv) {
      return windowWithElectron.electronAPI.getEnv(key) || fallback;
    }
  }

  return fallback;
}

// Mutable environment configuration that can be updated at runtime
let runtimeEnvironment: EnvironmentConfig | null = null;

// Initialize environment configuration
function initializeEnvironment(): EnvironmentConfig {
  const envUrl = getEnvVar('ADMIN_DASHBOARD_URL', 'http://localhost:3001');
  const envApiUrl = getEnvVar('ADMIN_API_BASE_URL', 'http://localhost:3001/api');

  return {
    NODE_ENV: getEnvVar('NODE_ENV', 'development'),
    ADMIN_DASHBOARD_URL: envUrl,
    ADMIN_API_BASE_URL: envApiUrl,
    SUPABASE_URL: getEnvVar('SUPABASE_URL', SUPABASE_CONFIG.url),
    SUPABASE_ANON_KEY: getEnvVar('SUPABASE_ANON_KEY', SUPABASE_CONFIG.anonKey),
    PAYMENT_MODE: getEnvVar('PAYMENT_MODE', 'test') as 'test' | 'production',
    PAYMENT_TEST_CARDS_ENABLED: getEnvVar('PAYMENT_TEST_CARDS_ENABLED', 'true') === 'true',
    DEBUG_LOGGING: getEnvVar('DEBUG_LOGGING', 'true') === 'true',
    POS_API_SHARED_KEY: getEnvVar('POS_API_SHARED_KEY', getEnvVar('POS_SYNC_SHARED_KEY', '')),
    POS_API_KEY: getEnvVar('POS_API_KEY', ''),
    TERMINAL_ID: getEnvVar('TERMINAL_ID', '')
  };
}

// Environment configuration
export const environment: EnvironmentConfig = initializeEnvironment();

// Update admin URL at runtime (called from renderer when settings change)
export async function updateAdminUrlFromSettings(): Promise<void> {
  if (typeof window === 'undefined') return; // Only in renderer

  try {
    const windowWithElectron = window as WindowWithElectronAPI & Window;
    // Use window.electron.ipcRenderer which is exposed by preload script
    if (windowWithElectron.electron?.ipcRenderer) {
      const adminUrl = await windowWithElectron.electron.ipcRenderer.invoke('settings:get-admin-url');
      if (adminUrl && adminUrl !== environment.ADMIN_DASHBOARD_URL) {
        console.log(`[environment] Updating admin URL from ${environment.ADMIN_DASHBOARD_URL} to ${adminUrl}`);
        environment.ADMIN_DASHBOARD_URL = adminUrl;
        environment.ADMIN_API_BASE_URL = adminUrl.replace(/\/$/, '') + '/api';
      }
    }
  } catch (error) {
    console.warn('[environment] Failed to update admin URL from settings:', error);
  }
}

// Utility functions
export const isDevelopment = () => environment.NODE_ENV === 'development';
export const isProduction = () => environment.NODE_ENV === 'production';

// API timeout configuration
// Increase default timeout to accommodate local dev & Supabase latency
export const API_TIMEOUT_MS = 8000; // 8 seconds

// API endpoint builders
/**
 * Constructs full API URL for Admin Dashboard endpoints
 * Used by CustomerService, MenuService, etc.
 * @param endpoint - API endpoint path (e.g., '/customers/search')
 * @returns Full URL (e.g., 'http://localhost:3001/api/customers/search')
 */
export const getApiUrl = (endpoint: string) => {
  const baseUrl = environment.ADMIN_API_BASE_URL.replace(/\/+$/, '');
  const cleanEndpoint = endpoint.replace(/^\/+/, '');
  return `${baseUrl}/${cleanEndpoint}`;
};

export const getDashboardUrl = (path: string = '') => {
  const baseUrl = environment.ADMIN_DASHBOARD_URL.replace(/\/+$/, '');
  const cleanPath = path.replace(/^\/+/, '');
  return cleanPath ? `${baseUrl}/${cleanPath}` : baseUrl;
};

// Export for debugging
if (isDevelopment()) {
  // Environment configuration logging removed
}