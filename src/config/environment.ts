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
  TERMINAL_ID: string;
}

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

function applyAdminDashboardUrl(adminUrl: string): void {
  const normalized = normalizeAdminDashboardUrl(adminUrl);
  if (!normalized) return;

  environment.ADMIN_DASHBOARD_URL = normalized;
  environment.ADMIN_API_BASE_URL = `${normalized}/api`;

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem('admin_dashboard_url', normalized);
    } catch {
      // Ignore localStorage errors (private mode/disabled storage)
    }
  }
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

// Initialize environment configuration
function initializeEnvironment(): EnvironmentConfig {
  const envDashboardUrl = normalizeAdminDashboardUrl(getEnvVar('ADMIN_DASHBOARD_URL', ''));
  const envApiBaseUrl = normalizeAdminDashboardUrl(getEnvVar('ADMIN_API_BASE_URL', ''));
  const persistedDashboardUrl =
    typeof window !== 'undefined'
      ? normalizeAdminDashboardUrl(window.localStorage.getItem('admin_dashboard_url') || '')
      : '';
  const adminDashboardUrl = envDashboardUrl || envApiBaseUrl || persistedDashboardUrl || 'http://localhost:3001';

  return {
    NODE_ENV: getEnvVar('NODE_ENV', 'development'),
    ADMIN_DASHBOARD_URL: adminDashboardUrl,
    ADMIN_API_BASE_URL: `${adminDashboardUrl}/api`,
    SUPABASE_URL: getEnvVar('SUPABASE_URL', SUPABASE_CONFIG.url),
    SUPABASE_ANON_KEY: getEnvVar('SUPABASE_ANON_KEY', SUPABASE_CONFIG.anonKey),
    PAYMENT_MODE: getEnvVar('PAYMENT_MODE', 'test') as 'test' | 'production',
    PAYMENT_TEST_CARDS_ENABLED: getEnvVar('PAYMENT_TEST_CARDS_ENABLED', 'true') === 'true',
    DEBUG_LOGGING: getEnvVar('DEBUG_LOGGING', 'true') === 'true',
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
    let resolvedAdminUrl = '';

    // Use window.electron.ipcRenderer which is exposed by preload script
    if (windowWithElectron.electron?.ipcRenderer) {
      const adminUrl = await windowWithElectron.electron.ipcRenderer.invoke('settings:get-admin-url');
      resolvedAdminUrl = normalizeAdminDashboardUrl((adminUrl || '').toString());
    }

    if (!resolvedAdminUrl) {
      resolvedAdminUrl = normalizeAdminDashboardUrl(window.localStorage.getItem('admin_dashboard_url') || '');
    }

    if (resolvedAdminUrl && resolvedAdminUrl !== environment.ADMIN_DASHBOARD_URL) {
      console.log(`[environment] Updating admin URL from ${environment.ADMIN_DASHBOARD_URL} to ${resolvedAdminUrl}`);
      applyAdminDashboardUrl(resolvedAdminUrl);
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
 * @param endpoint - API endpoint path (e.g., 'pos/customers' or '/api/pos/customers')
 * @returns Full URL (e.g., 'http://localhost:3001/api/pos/customers')
 */
export const getApiUrl = (endpoint: string) => {
  const baseUrl = environment.ADMIN_API_BASE_URL.replace(/\/+$/, '');
  // Remove leading slashes and 'api/' prefix since base URL already includes /api
  const cleanEndpoint = endpoint.replace(/^\/+/, '').replace(/^api\//, '');
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
