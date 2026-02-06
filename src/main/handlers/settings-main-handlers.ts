/**
 * Settings Main Handlers Module
 *
 * Handles settings-related IPC handlers that are in main.ts.
 * Note: Additional settings handlers are in settings-handlers.ts
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../service-registry';
import { handleIPCError } from './utils';

/**
 * Register settings-related IPC handlers from main.ts
 */
export function registerSettingsMainHandlers(): void {
  // Check if terminal is configured (has API key and admin URL)
  ipcMain.removeHandler('settings:is-configured');
  ipcMain.handle('settings:is-configured', async () => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService;
      console.log('[settings:is-configured] ========== CHECK START ==========');
      console.log('[settings:is-configured] settingsService available:', !!settingsService);
      if (!settingsService) {
        console.log('[settings:is-configured] Settings service not initialized - returning NOT configured');
        return { configured: false, reason: 'Settings service not initialized' };
      }

      // Check for required configuration in 'terminal' category
      // IMPORTANT: Only check database settings, NOT environment variables
      const apiKey = settingsService.getSetting<string>('terminal', 'pos_api_key', '');
      const adminUrl = settingsService.getSetting<string>('terminal', 'admin_dashboard_url', '');

      console.log('[settings:is-configured] Database values:');
      console.log('[settings:is-configured]   hasApiKey:', !!apiKey);
      console.log('[settings:is-configured]   adminUrl:', adminUrl ? `"${adminUrl}"` : '(empty)');

      // Both must be non-empty strings to be considered configured
      const hasApiKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
      const hasAdminUrl = typeof adminUrl === 'string' && adminUrl.trim().length > 0;
      const configured = hasApiKey && hasAdminUrl;
      
      console.log('[settings:is-configured] Result: hasApiKey=%s, hasAdminUrl=%s, configured=%s', hasApiKey, hasAdminUrl, configured);
      console.log('[settings:is-configured] ========== CHECK END ==========');
      
      return {
        configured,
        reason: configured ? 'Terminal is configured' : `Missing: ${!hasApiKey ? 'API key' : ''}${!hasApiKey && !hasAdminUrl ? ' and ' : ''}${!hasAdminUrl ? 'admin URL' : ''}`
      };
    }, 'settings:is-configured');
  });

  // Settings handlers
  ipcMain.handle('get-settings', async () => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      return await settingsService.getSettings();
    }, 'get-settings');
  });

  ipcMain.handle('update-settings', async (event, settings) => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      await settingsService.updateSettings(settings);
    }, 'update-settings');
  });

  // Local settings handlers (for compatibility with old settings-service.ts)
  ipcMain.removeHandler('settings:get-local');
  ipcMain.handle('settings:get-local', async () => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      return await settingsService.getSettings();
    }, 'settings:get-local');
  });

  ipcMain.removeHandler('settings:update-local');
  ipcMain.handle('settings:update-local', async (event, { settingType, settings }) => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      // Update settings by category
      const updates: Record<string, any> = {};
      for (const [key, value] of Object.entries(settings)) {
        updates[`${settingType}.${key}`] = value;
      }
      await settingsService.updateSettings(updates);
    }, 'settings:update-local');
  });

  // Push settings upstream to Admin from POS (bidirectional sync)
  ipcMain.removeHandler('settings:push-to-admin');
  ipcMain.handle(
    'settings:push-to-admin',
    async (_event, { settingType, settings, incrementVersion = true }) => {
      return handleIPCError(async () => {
        const adminDashboardSyncService = serviceRegistry.adminDashboardSyncService ?? serviceRegistry.requireService('adminDashboardSyncService');
        const payload = settings && typeof settings === 'object' ? settings : {};
        const res = await adminDashboardSyncService.pushSettingsToAdmin(
          String(settingType || 'terminal'),
          payload,
          !!incrementVersion
        );
        return res;
      }, 'settings:push-to-admin');
    }
  );

  // Discount settings handlers
  ipcMain.handle('settings:get-discount-max', async () => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      return settingsService.getDiscountMaxPercentage();
    }, 'settings:get-discount-max');
  });

  ipcMain.handle('settings:set-discount-max', async (event, percentage: number) => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      settingsService.setDiscountMaxPercentage(percentage);
    }, 'settings:set-discount-max');
  });

  // Tax settings handlers
  ipcMain.handle('settings:get-tax-rate', async () => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      return settingsService.getTaxRatePercentage();
    }, 'settings:get-tax-rate');
  });

  ipcMain.handle('settings:set-tax-rate', async (event, percentage: number) => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      settingsService.setTaxRatePercentage(percentage);
    }, 'settings:set-tax-rate');
  });

  // Generic settings setter (for console/debugging)
  ipcMain.handle('settings:set', async (_, { category, key, value }) => {
    return handleIPCError(async () => {
      const dbManager = serviceRegistry.dbManager ?? serviceRegistry.requireService('dbManager');
      const databaseService = dbManager.getDatabaseService();
      databaseService.settings.setSetting(category, key, value);
      console.log(`✅ Setting saved: ${category}.${key} = ${JSON.stringify(value)}`);
      return { message: `Setting ${category}.${key} saved successfully` };
    }, 'settings:set');
  });

  // Settings version management handlers
  ipcMain.handle('settings:get-version', async (_, category: string) => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      return settingsService.getSettingsVersion(category as any);
    }, 'settings:get-version');
  });

  ipcMain.handle('settings:get-all-versions', async () => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      return settingsService.getAllSettingsVersions();
    }, 'settings:get-all-versions');
  });

  ipcMain.handle('settings:get-sync-status', async () => {
    return handleIPCError(async () => {
      const settingsService = serviceRegistry.settingsService ?? serviceRegistry.requireService('settingsService');
      const versions = settingsService.getAllSettingsVersions();
      const categories = Object.keys(versions);

      const status: Record<string, any> = {};
      for (const category of categories) {
        status[category] = {
          version: versions[category as keyof typeof versions],
          last_sync: settingsService.getLastSyncTime(category as any),
          status: 'synced',
        };
      }
      return status;
    }, 'settings:get-sync-status');
  });

  ipcMain.handle('settings:force-sync', async (_, category?: string) => {
    return handleIPCError(async () => {
      // 1) Pull latest settings from Admin Dashboard API (wires POS to Admin for settings)
      const adminDashboardSyncService = serviceRegistry.adminDashboardSyncService;
      if (adminDashboardSyncService) {
        try {
          await adminDashboardSyncService.forceSync();
        } catch (adminErr) {
          console.warn('Admin settings sync failed (continuing to Supabase sync):', adminErr);
        }
      }

      // 2) Run enhanced settings sync via Supabase + a general force sync
      const syncService = serviceRegistry.syncService ?? serviceRegistry.requireService('syncService');
      await syncService.syncAllEnhanced(true);
      await syncService.forceSync(15000);
    }, 'settings:force-sync');
  });
}
