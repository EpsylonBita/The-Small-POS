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
 * THE-306 gating sweep: true when an admin POS API failure is the uniform
 * module-acquisition denial (`403 {error:'MODULE_REQUIRED',...}`). Both
 * transports preserve the marker — the web path returns the error code
 * verbatim and the IPC path embeds it in admin_fetch's
 * "MODULE_REQUIRED (HTTP 403): ..." message — so callers can park work on a
 * slow probe cadence instead of hot-retrying an unowned module.
 */
export function isModuleRequiredApiError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.includes('MODULE_REQUIRED');
}

function normalizeTransportError(method: string, error?: string | null): string {
  const fallback =
    method === 'GET'
      ? 'No cached local data is available yet. Connect once while online to download it.'
      : 'This action requires an online connection.';

  if (!error) {
    return fallback;
  }

  const normalized = error.toLowerCase();
  const statusMatch = error.match(/HTTP\s+(\d{3})/i);
  const htmlResponse =
    normalized.includes('<!doctype html') ||
    normalized.includes('<html') ||
    normalized.includes('__next_data__') ||
    normalized.includes('page not found');

  if (htmlResponse) {
    if (normalized.includes('admin dashboard endpoint not found') || statusMatch?.[1] === '404') {
      return 'Admin dashboard endpoint not found. Restart or update the admin dashboard, then try again.';
    }
    return statusMatch?.[1]
      ? `Admin dashboard returned an HTML error page (HTTP ${statusMatch[1]}).`
      : 'Admin dashboard returned an HTML error page.';
  }

  if (
    normalized.includes('failed to fetch') ||
    normalized.includes('network error') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('connection') ||
    normalized.includes('offline')
  ) {
    return fallback;
  }

  if (error.length > 800) {
    return `${error.slice(0, 400).trim()}...`;
  }

  return error;
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
 * What a POS admin API call answered.
 *
 * `stale: true` (`source: 'cache'`) means the office was not reached
 * (offline, timeout, 5xx) and `data` is the copy this till saved at
 * `cachedAt` (null when unknown). It stays `success: true` because offline
 * readers rely on that copy, but a screen must show it as a saved copy and
 * never as the office's current answer (desktop 1.4.123 dropped the marker
 * and showed a lapsed Wolt licence as "Connected").
 */
export interface PosApiResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;
  /** The office's machine code on a refusal, e.g. `SUPPLIER_INVOICE_AMOUNT_HAS_PAYMENTS`. */
  code?: string;
  source?: 'remote' | 'cache';
  stale?: boolean;
  cachedAt?: string | null;
}

function readTypedCode(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 120 ? value : undefined;
}

/** The bridge's saved-copy marker (`meta.source: 'cache'` / `meta.offlineFallback`). */
function readSavedCopyMarker(ipcResult: unknown): Pick<PosApiResult, 'source' | 'stale' | 'cachedAt'> {
  const meta = (ipcResult as { meta?: { source?: unknown; offlineFallback?: unknown; cachedAt?: unknown } } | null)?.meta;
  if (meta?.source === 'cache' || meta?.offlineFallback === true) {
    return {
      source: 'cache',
      stale: true,
      cachedAt: typeof meta.cachedAt === 'string' && meta.cachedAt ? meta.cachedAt : null,
    };
  }
  return { source: 'remote', stale: false };
}

/**
 * Authenticated fetch wrapper for Admin Dashboard API calls
 * Automatically adds terminal ID and API key headers
 */
export async function posApiFetch<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<PosApiResult<T>> {
  const method = (options.method || 'GET').toUpperCase();
  try {
    const callerHeaders = normalizeHeaders(options.headers);
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
        const code = readTypedCode((ipcResult as { code?: unknown } | null)?.code);
        return {
          success: false,
          error: normalizeTransportError(
            method,
            ipcResult?.error || 'Failed to fetch from admin API',
          ),
          status: ipcResult?.status,
          ...(code ? { code } : {}),
        };
      }

      return {
        success: true,
        data: (ipcResult?.data ?? ipcResult) as T,
        status: ipcResult.status,
        ...readSavedCopyMarker(ipcResult),
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
      const code = readTypedCode(errorData?.code);
      return {
        success: false,
        error: errorData.error || errorData.message || `HTTP ${response.status}`,
        status: response.status,
        ...(code ? { code } : {}),
      };
    }

    const data = await response.json();
    return { success: true, data, status: response.status, source: 'remote', stale: false };
  } catch (error: any) {
    console.error(`[posApiFetch] ${endpoint} error:`, error);
    return {
      success: false,
      error: normalizeTransportError(method, error.message || 'Network error'),
    };
  }
}

/**
 * Shorthand for GET requests
 */
export async function posApiGet<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<PosApiResult<T>> {
  return posApiFetch<T>(endpoint, { ...options, method: 'GET' });
}

/**
 * Shorthand for POST requests
 */
export async function posApiPost<T = any>(
  endpoint: string,
  body: any
): Promise<PosApiResult<T>> {
  return posApiFetch<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Shorthand for PUT requests
 */
export async function posApiPut<T = any>(
  endpoint: string,
  body: any
): Promise<PosApiResult<T>> {
  return posApiFetch<T>(endpoint, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * Shorthand for PATCH requests
 */
export async function posApiPatch<T = any>(
  endpoint: string,
  body: any
): Promise<PosApiResult<T>> {
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
): Promise<PosApiResult<T>> {
  return posApiFetch<T>(endpoint, { method: 'DELETE' });
}
