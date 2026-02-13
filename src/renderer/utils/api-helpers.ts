/**
 * API Helper utilities for POS renderer process
 * Provides authenticated fetch wrapper for Admin Dashboard API calls
 */

import { getApiUrl } from '../../config/environment';

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};

  const normalized: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      normalized[String(key)] = String(value);
    }
    return normalized;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'undefined') {
      normalized[key] = String(value);
    }
  }
  return normalized;
}

function toAdminApiPath(endpoint: string): string {
  const trimmed = (endpoint || '').trim();
  if (!trimmed) return '/api';

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const clean = trimmed.replace(/^\/+/, '').replace(/^api\/+/, '');
  return `/api/${clean}`;
}

type ElectronApiBridge = {
  fetchFromApi?: (
    path: string,
    options?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    }
  ) => Promise<{ success: boolean; data?: unknown; error?: string; status?: number }>;
};

/**
 * Get POS authentication headers for API calls
 * Fetches terminal ID and API key from the main process via IPC
 */
export async function getPosAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  try {
    const windowWithElectron = window as any;
    const electronAPI = windowWithElectron.electronAPI || windowWithElectron.electron;

    if (!electronAPI) {
      console.warn('[api-helpers] electronAPI not available');
      return headers;
    }

    // Get terminal ID using the exposed method
    if (electronAPI.getTerminalId) {
      const terminalId = await electronAPI.getTerminalId();
      if (terminalId) {
        headers['x-terminal-id'] = terminalId;
      }
    }

    // Get API key using the exposed method
    if (electronAPI.getTerminalApiKey) {
      const apiKey = await electronAPI.getTerminalApiKey();
      if (apiKey) {
        // The API key might be stored as JSON string, parse if needed
        const parsedKey = typeof apiKey === 'string' && apiKey.startsWith('"')
          ? JSON.parse(apiKey)
          : apiKey;
        if (parsedKey) {
          headers['x-pos-api-key'] = parsedKey;
        }
      }
    }
  } catch (error) {
    console.warn('[api-helpers] Failed to get POS auth headers:', error);
  }

  return headers;
}

/**
 * Authenticated fetch wrapper for Admin Dashboard API calls
 * Automatically adds terminal ID and API key headers
 */
export async function posApiFetch<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ success: boolean; data?: T; error?: string; status?: number }> {
  try {
    const authHeaders = await getPosAuthHeaders();
    const callerHeaders = normalizeHeaders(options.headers);
    const mergedHeaders = {
      ...authHeaders,
      ...callerHeaders,
    };
    const method = (options.method || 'GET').toUpperCase();
    const windowWithElectron = typeof window !== 'undefined' ? (window as any) : undefined;
    const electronAPI: ElectronApiBridge | undefined = windowWithElectron
      ? windowWithElectron.electronAPI || windowWithElectron.electron
      : undefined;

    if (electronAPI?.fetchFromApi) {
      const ipcResult = await electronAPI.fetchFromApi(toAdminApiPath(endpoint), {
        method,
        body: options.body,
        headers: mergedHeaders,
      });

      if (!ipcResult?.success) {
        return {
          success: false,
          error: ipcResult?.error || 'Failed to fetch from admin API',
          status: ipcResult?.status,
        };
      }

      return {
        success: true,
        data: ipcResult.data as T,
        status: ipcResult.status,
      };
    }

    const url = getApiUrl(endpoint);

    const response = await fetch(url, {
      ...options,
      headers: mergedHeaders,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      console.error(`[posApiFetch] ${endpoint} failed:`, response.status, errorData);
      return { 
        success: false, 
        error: errorData.error || errorData.message || `HTTP ${response.status}`,
        status: response.status
      };
    }

    const data = await response.json();
    return { success: true, data, status: response.status };
  } catch (error: any) {
    console.error(`[posApiFetch] ${endpoint} error:`, error);
    return { success: false, error: error.message || 'Network error' };
  }
}

/**
 * Shorthand for GET requests
 */
export async function posApiGet<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ success: boolean; data?: T; error?: string; status?: number }> {
  return posApiFetch<T>(endpoint, { ...options, method: 'GET' });
}

/**
 * Shorthand for POST requests
 */
export async function posApiPost<T = any>(
  endpoint: string,
  body: any
): Promise<{ success: boolean; data?: T; error?: string }> {
  return posApiFetch<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Shorthand for PATCH requests
 */
export async function posApiPatch<T = any>(
  endpoint: string,
  body: any
): Promise<{ success: boolean; data?: T; error?: string }> {
  return posApiFetch<T>(endpoint, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/**
 * Shorthand for DELETE requests
 */
export async function posApiDelete<T = any>(
  endpoint: string
): Promise<{ success: boolean; data?: T; error?: string }> {
  return posApiFetch<T>(endpoint, { method: 'DELETE' });
}
