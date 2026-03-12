/**
 * API Helper utilities for POS renderer process
 * Provides authenticated fetch wrapper for Admin Dashboard API calls
 */

import { getApiUrl } from '../../config/environment';
import { getBridge } from '../../lib';

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const runtime = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    __TAURI_IPC__?: unknown;
  };
  return Boolean(runtime.__TAURI_INTERNALS__ || runtime.__TAURI__ || runtime.__TAURI_IPC__);
}

let hasLoggedTransportPath = false;

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

/**
 * Get POS authentication headers for API calls
 * Fetches terminal identity from the main process via IPC.
 * Native Tauri admin fetches handle API key authentication internally.
 */
export async function getPosAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  try {
    if (!isTauriRuntime()) {
      return headers;
    }

    const bridge = getBridge();

    // Get terminal ID from native terminal config
    const terminalId = await bridge.terminalConfig.getTerminalId().catch(() => null);
    if (terminalId) {
      headers['x-terminal-id'] = terminalId;
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
    const callerHeaders = normalizeHeaders(options.headers);
    const method = (options.method || 'GET').toUpperCase();
    const useTauriIpc = isTauriRuntime();
    const authHeaders = useTauriIpc ? {} : await getPosAuthHeaders();
    const mergedHeaders = {
      ...authHeaders,
      ...callerHeaders,
    };

    if (!hasLoggedTransportPath) {
      hasLoggedTransportPath = true;
      console.info(`[posApiFetch] transport=${useTauriIpc ? 'tauri-ipc' : 'browser-fetch'}`);
    }

    if (useTauriIpc) {
      const bridge = getBridge();
      const { ['x-pos-api-key']: _ignoredPosApiKey, ['x-terminal-id']: _ignoredTerminalId, ...nativeHeaders } =
        mergedHeaders;
      const ipcResult = await bridge.adminApi.fetchFromAdmin(toAdminApiPath(endpoint), {
        method,
        body: options.body,
        headers: nativeHeaders,
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
        data: (ipcResult?.data ?? ipcResult) as T,
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
