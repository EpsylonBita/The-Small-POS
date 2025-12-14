/**
 * Module Handlers Module
 *
 * Handles module-related IPC operations for syncing modules from admin dashboard.
 * 
 * Requirements: 1.1, 1.2, 5.1
 */

import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { serviceRegistry } from '../service-registry';
import type { POSModulesEnabledResponse, POSModuleInfo } from '../../shared/types/modules';

/**
 * Cache file path for module data
 */
const MODULE_CACHE_FILE = 'module-cache.json';

/**
 * Cache TTL in milliseconds (24 hours)
 * Requirement 5.1
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Module cache data structure
 */
interface ModuleCacheData {
  /** Modules fetched from admin dashboard API */
  apiModules: POSModuleInfo[];
  /** Organization ID */
  organizationId: string;
  /** Terminal ID */
  terminalId: string;
  /** Cache timestamp */
  timestamp: number;
  /** API response timestamp for sync tracking */
  apiTimestamp: string;
}

/**
 * Get the cache file path
 */
function getCacheFilePath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, MODULE_CACHE_FILE);
}

/**
 * Read cached modules from disk
 * Requirement 5.1, 5.2
 */
function readCachedModules(): ModuleCacheData | null {
  try {
    const cacheFilePath = getCacheFilePath();
    
    if (!fs.existsSync(cacheFilePath)) {
      return null;
    }

    const cacheContent = fs.readFileSync(cacheFilePath, 'utf-8');
    const cacheData: ModuleCacheData = JSON.parse(cacheContent);

    // Validate cache structure
    if (!cacheData || !Array.isArray(cacheData.apiModules)) {
      console.warn('[ModuleHandlers] Invalid cache structure');
      return null;
    }

    return cacheData;
  } catch (error) {
    console.error('[ModuleHandlers] Error reading cache:', error);
    return null;
  }
}

/**
 * Write modules to cache on disk
 * Requirement 1.2, 5.1
 */
function writeCachedModules(cacheData: ModuleCacheData): boolean {
  try {
    const cacheFilePath = getCacheFilePath();
    fs.writeFileSync(cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf-8');
    console.log(`[ModuleHandlers] Cache saved with ${cacheData.apiModules.length} modules`);
    return true;
  } catch (error) {
    console.error('[ModuleHandlers] Error writing cache:', error);
    return false;
  }
}

/**
 * Check if cache is still valid (within TTL)
 * Requirement 5.1
 */
function isCacheValid(cacheData: ModuleCacheData | null): boolean {
  if (!cacheData) {
    return false;
  }

  const now = Date.now();
  const cacheAge = now - cacheData.timestamp;
  
  return cacheAge < CACHE_TTL_MS;
}

// Throttle state for fetch-from-admin
let lastFetchTime = 0;
let pendingFetchPromise: Promise<any> | null = null;
const FETCH_THROTTLE_MS = 5000; // Minimum 5 seconds between fetches

/**
 * Register module-related IPC handlers
 * 
 * Requirements: 1.1, 1.2, 5.1
 */
export function registerModuleHandlers(): void {
  /**
   * Fetch modules from admin dashboard API
   * Throttled to prevent excessive API calls
   * Requirement 1.1
   */
  ipcMain.removeHandler('modules:fetch-from-admin');
  ipcMain.handle('modules:fetch-from-admin', async () => {
    try {
      const now = Date.now();
      
      // If a fetch is already in progress, return the pending promise result
      if (pendingFetchPromise) {
        console.log('[ModuleHandlers] Fetch already in progress, waiting for result');
        return pendingFetchPromise;
      }
      
      // If we fetched recently, return cached data instead
      if (now - lastFetchTime < FETCH_THROTTLE_MS) {
        const cachedData = readCachedModules();
        if (cachedData && cachedData.apiModules.length > 0) {
          console.log('[ModuleHandlers] Throttled: returning cached modules');
          return {
            success: true,
            modules: {
              success: true,
              modules: cachedData.apiModules,
              organization_id: cachedData.organizationId,
              terminal_id: cachedData.terminalId,
              timestamp: cachedData.apiTimestamp,
              stats: {
                total_modules: cachedData.apiModules.length,
                core_modules_count: cachedData.apiModules.filter(m => m.is_core).length,
                purchased_modules_count: cachedData.apiModules.filter(m => m.is_purchased).length,
              },
              processing_time_ms: 0,
            } as POSModulesEnabledResponse,
            fromCache: true,
            throttled: true,
          };
        }
      }
      
      const moduleSyncService = serviceRegistry.moduleSyncService;
      
      if (!moduleSyncService) {
        console.warn('[ModuleHandlers] ModuleSyncService not available');
        return {
          success: false,
          error: 'ModuleSyncService not initialized',
          modules: null,
        };
      }

      // Create the fetch promise and store it
      pendingFetchPromise = (async () => {
        try {
          // Force sync to get fresh modules
          const result = await moduleSyncService.forceSync();
          lastFetchTime = Date.now();
          return result;
        } finally {
          pendingFetchPromise = null;
        }
      })();
      
      const result = await pendingFetchPromise;

      if (result.success && result.modules) {
        // Save to cache on successful fetch (Requirement 1.2)
        const cacheData: ModuleCacheData = {
          apiModules: result.modules.modules,
          organizationId: result.modules.organization_id,
          terminalId: result.modules.terminal_id,
          timestamp: Date.now(),
          apiTimestamp: result.modules.timestamp,
        };
        writeCachedModules(cacheData);

        return {
          success: true,
          modules: result.modules,
          fromCache: false,
        };
      }

      // On failure, try to return cached modules (Requirement 1.3)
      const cachedData = readCachedModules();
      if (cachedData && cachedData.apiModules.length > 0) {
        console.log('[ModuleHandlers] Returning cached modules after fetch failure');
        return {
          success: true,
          modules: {
            success: true,
            modules: cachedData.apiModules,
            organization_id: cachedData.organizationId,
            terminal_id: cachedData.terminalId,
            timestamp: cachedData.apiTimestamp,
            stats: {
              total_modules: cachedData.apiModules.length,
              core_modules_count: cachedData.apiModules.filter(m => m.is_core).length,
              purchased_modules_count: cachedData.apiModules.filter(m => m.is_purchased).length,
            },
            processing_time_ms: 0,
          } as POSModulesEnabledResponse,
          fromCache: true,
        };
      }

      return {
        success: false,
        error: result.error || 'Failed to fetch modules',
        modules: null,
      };
    } catch (error) {
      console.error('[ModuleHandlers] modules:fetch-from-admin failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        modules: null,
      };
    }
  });

  /**
   * Get cached modules from local storage
   * Requirement 5.1, 5.2
   */
  ipcMain.removeHandler('modules:get-cached');
  ipcMain.handle('modules:get-cached', async () => {
    try {
      const cachedData = readCachedModules();

      if (!cachedData) {
        return {
          success: false,
          error: 'No cached modules found',
          modules: null,
          isValid: false,
        };
      }

      const isValid = isCacheValid(cachedData);

      return {
        success: true,
        modules: {
          success: true,
          modules: cachedData.apiModules,
          organization_id: cachedData.organizationId,
          terminal_id: cachedData.terminalId,
          timestamp: cachedData.apiTimestamp,
          stats: {
            total_modules: cachedData.apiModules.length,
            core_modules_count: cachedData.apiModules.filter(m => m.is_core).length,
            purchased_modules_count: cachedData.apiModules.filter(m => m.is_purchased).length,
          },
          processing_time_ms: 0,
        } as POSModulesEnabledResponse,
        isValid,
        cacheAge: Date.now() - cachedData.timestamp,
      };
    } catch (error) {
      console.error('[ModuleHandlers] modules:get-cached failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        modules: null,
        isValid: false,
      };
    }
  });

  /**
   * Save modules to local cache
   * Requirement 1.2, 5.1
   */
  ipcMain.removeHandler('modules:save-cache');
  ipcMain.handle('modules:save-cache', async (_event, data: {
    modules: POSModuleInfo[];
    organizationId: string;
    terminalId: string;
    apiTimestamp: string;
  }) => {
    try {
      if (!data || !Array.isArray(data.modules)) {
        return {
          success: false,
          error: 'Invalid cache data provided',
        };
      }

      const cacheData: ModuleCacheData = {
        apiModules: data.modules,
        organizationId: data.organizationId,
        terminalId: data.terminalId,
        timestamp: Date.now(),
        apiTimestamp: data.apiTimestamp,
      };

      const saved = writeCachedModules(cacheData);

      return {
        success: saved,
        error: saved ? undefined : 'Failed to write cache file',
      };
    } catch (error) {
      console.error('[ModuleHandlers] modules:save-cache failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  console.log('[ModuleHandlers] Module IPC handlers registered');
}
