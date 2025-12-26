import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import { getSupabaseClient } from '../../../shared/supabase-config';
import { initializeMainLanguageFromSettings } from '../../lib/main-i18n';

/**
 * Registers settings-related IPC handlers (general settings, terminal config,
 * discounts, tax, and version/sync metadata).
 *
 * Extracted from main.ts to reduce main-process bloat.
 */
export function registerSettingsHandlers(): void {
  const settingsService = serviceRegistry.settingsService;
  const dbManager = serviceRegistry.dbManager;
  
  if (!settingsService || !dbManager) {
    console.error('[SettingsHandlers] Required services (settingsService, dbManager) not initialized');
    return;
  }

  // Initialize main process i18n with saved language from settings
  initializeMainLanguageFromSettings(settingsService);

  const terminalConfigService = serviceRegistry.terminalConfigService;
  const adminDashboardSyncService = serviceRegistry.adminDashboardSyncService;
  const syncService = serviceRegistry.syncService;
  const mainWindow = serviceRegistry.mainWindow;

  // Get admin dashboard URL (for renderer process to use in API calls)
  ipcMain.removeHandler('settings:get-admin-url');
  ipcMain.handle('settings:get-admin-url', async () => {
    try {
      // Try direct admin_dashboard_url setting first
      let storedUrl = settingsService.getSetting<string>('terminal', 'admin_dashboard_url', '');

      // Also try databaseService.settings (same DB, different accessor)
      if (!storedUrl) {
        try {
          const databaseService = dbManager.getDatabaseService();
          storedUrl = databaseService.settings.getSetting<string>('terminal', 'admin_dashboard_url', '') || '';
        } catch (e) {
          console.warn('[settings:get-admin-url] Failed to get from databaseService:', e);
        }
      }

      // If still no URL, try to extract from pos_api_key (which might be a connection string)
      if (!storedUrl) {
        try {
          const posApiKey = settingsService.getSetting<string>('terminal', 'pos_api_key', '');
          if (posApiKey && posApiKey.length > 50) { // Connection strings are typically long (base64 encoded JSON)
            // Try to decode as connection string
            const base64 = posApiKey.replace(/-/g, '+').replace(/_/g, '/');
            const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
            const decoded = Buffer.from(padded, 'base64').toString('utf-8');
            const parsed = JSON.parse(decoded);
            if (parsed.url) {
              storedUrl = parsed.url;
              console.log(`[settings:get-admin-url] Extracted URL from connection string: ${storedUrl}`);
              // Store it for future use
              settingsService.setSetting('terminal', 'admin_dashboard_url', storedUrl);
            }
          }
        } catch (e) {
          // Not a connection string, that's fine
          console.log('[settings:get-admin-url] pos_api_key is not a connection string');
        }
      }

      if (storedUrl) {
        // Ensure URL has protocol prefix
        if (!storedUrl.startsWith('http://') && !storedUrl.startsWith('https://')) {
          storedUrl = 'https://' + storedUrl;
          console.log(`[settings:get-admin-url] Added https:// prefix to URL: ${storedUrl}`);
          // Store the corrected URL
          settingsService.setSetting('terminal', 'admin_dashboard_url', storedUrl);
        }
        console.log(`[settings:get-admin-url] Returning stored admin URL: ${storedUrl}`);
        return storedUrl;
      }
      // Fallback to env
      const envUrl = process.env.ADMIN_DASHBOARD_URL || process.env.ADMIN_API_BASE_URL || 'http://localhost:3001';
      console.log(`[settings:get-admin-url] Returning env admin URL: ${envUrl}`);
      return envUrl;
    } catch (error) {
      console.error('Get admin URL error:', error);
      return 'http://localhost:3001';
    }
  });

  // Clear admin URL and API key (for reconfiguration)
  ipcMain.removeHandler('settings:clear-connection');
  ipcMain.handle('settings:clear-connection', async () => {
    try {
      settingsService.setSetting('terminal', 'admin_dashboard_url', '');
      settingsService.setSetting('terminal', 'pos_api_key', '');
      console.log('[settings:clear-connection] Cleared admin URL and API key');
      return { success: true };
    } catch (error) {
      console.error('Clear connection error:', error);
      return { success: false, error: String(error) };
    }
  });

  // Settings handlers
  ipcMain.removeHandler('get-settings');
  ipcMain.handle('get-settings', async () => {
    try {
      return await settingsService.getSettings();
    } catch (error) {
      console.error('Get settings error:', error);
      return {};
    }
  });

  ipcMain.removeHandler('update-settings');
  ipcMain.handle('update-settings', async (_event, settings) => {
    try {
      await settingsService.updateSettings(settings);
      return { success: true };
    } catch (error) {
      console.error('Update settings error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Local settings handlers (for compatibility with old settings-service.ts)
  ipcMain.removeHandler('settings:get-local');
  ipcMain.handle('settings:get-local', async () => {
    try {
      return await settingsService.getSettings();
    } catch (error) {
      console.error('settings:get-local failed:', error);
      return {};
    }
  });

  ipcMain.removeHandler('settings:update-local');
  ipcMain.handle('settings:update-local', async (_event, { settingType, settings }) => {
    try {
      const updates: Record<string, any> = {};
      for (const [key, value] of Object.entries(settings)) {
        updates[`${settingType}.${key}`] = value;
      }
      await settingsService.updateSettings(updates);
      return { success: true };
    } catch (error) {
      console.error('settings:update-local failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Push settings upstream to Admin from POS (bidirectional sync)
  ipcMain.removeHandler('settings:push-to-admin');
  ipcMain.handle('settings:push-to-admin', async (_event, { settingType, settings, incrementVersion = true }) => {
    try {
      if (!adminDashboardSyncService) throw new Error('Sync service unavailable');
      const payload = settings && typeof settings === 'object' ? settings : {};
      const res = await adminDashboardSyncService.pushSettingsToAdmin(
        String(settingType || 'terminal'),
        payload,
        !!incrementVersion,
      );
      return res;
    } catch (error) {
      console.error('settings:push-to-admin failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Terminal configuration handlers
  ipcMain.removeHandler('terminal-config:get-settings');
  ipcMain.handle('terminal-config:get-settings', async () => {
    try {
      // Merge settings from both TerminalConfigService (pos_configurations)
      // and SettingsService (local_settings) to include API key
      const localSettings = await settingsService.getSettings();
      console.log('[terminal-config:get-settings] localSettings:', JSON.stringify(localSettings, null, 2));

      if (terminalConfigService) {
        const terminalSettings = terminalConfigService.getSettings();
        console.log('[terminal-config:get-settings] terminalSettings:', JSON.stringify(terminalSettings, null, 2));
        // Merge: local_settings takes precedence for credentials
        const merged = { ...terminalSettings, ...localSettings };
        console.log('[terminal-config:get-settings] merged result:', JSON.stringify(merged, null, 2));
        return merged;
      }
      console.log('[terminal-config:get-settings] returning localSettings only');
      return localSettings;
    } catch (error) {
      console.error('terminal-config:get-settings failed:', error);
      return {};
    }
  });

  ipcMain.removeHandler('terminal-config:get-setting');
  ipcMain.handle('terminal-config:get-setting', async (_event, category: string, key: string) => {
    try {
      // Check local_settings first (for credentials like pos_api_key)
      const svc = dbManager.getDatabaseService().settings;
      const localValue = svc.getSetting(category as any, key, null);
      if (localValue !== null) {
        return localValue;
      }

      // Fallback to TerminalConfigService (pos_configurations)
      if (terminalConfigService) {
        const fullKey = category && key ? `${category}.${key}` : (key || category);
        return terminalConfigService.getSetting(fullKey, null);
      }
      return null;
    } catch (error) {
      console.error('terminal-config:get-setting failed:', error);
      return null;
    }
  });

  ipcMain.removeHandler('terminal-config:get-branch-id');
  ipcMain.handle('terminal-config:get-branch-id', async () => {
    try {
      if (terminalConfigService) {
        const bid = terminalConfigService.getBranchId();
        if (bid) return bid;
      }

      try {
        const saved = settingsService?.getSetting?.('terminal', 'branch_id', null) as string | null;
        if (saved) return saved as string;
      } catch { }

      const persistedTerminalId = settingsService.getSetting<string>('terminal', 'terminal_id', '');
      const terminalId = process.env.TERMINAL_ID || persistedTerminalId || null;

      if (terminalId) {
        try {
          const apiKey =
            (settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string) ||
            process.env.POS_API_SHARED_KEY ||
            '';
          if (apiKey) {
            // Get admin URL from local settings first
            const storedAdminUrl = settingsService?.getSetting?.('terminal', 'admin_dashboard_url', '') as string || '';
            const baseUrl = storedAdminUrl || process.env.ADMIN_API_BASE_URL || process.env.ADMIN_DASHBOARD_URL || 'http://localhost:3001';
            const base = baseUrl.replace(/\/$/, '') + (baseUrl.includes('/api') ? '' : '/api');
            const url = `${base}/pos/settings/${terminalId}`;
            const res = await fetch(url, {
              headers: {
                'x-terminal-id': terminalId,
                'x-pos-api-key': apiKey,
                accept: 'application/json',
              },
            });
            if (res.ok) {
              const json: any = await res.json();
              const bidFromAdmin =
                json?.branch_id || json?.settings?.terminal?.branch_id || json?.settings?.terminal?.branchId || null;
              if (bidFromAdmin) {
                try {
                  settingsService.setSetting('terminal', 'branch_id', bidFromAdmin);
                } catch { }
                return bidFromAdmin as string;
              }
            }
          }
        } catch (e) {
          console.warn('[main] Admin POS Settings fetch failed for branch resolution:', (e as any)?.message || e);
        }
      }

      const supabase = getSupabaseClient();
      if (supabase) {
        if (terminalId) {
          const { data, error } = await supabase
            .from('pos_configurations')
            .select('branch_id')
            .eq('terminal_id', terminalId)
            .eq('is_active', true)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!error && (data as any)?.branch_id) return (data as any).branch_id as string;
        }

        if (terminalId) {
          const { data: termRow, error: termErr } = await supabase
            .from('pos_terminals')
            .select('branch_id')
            .eq('terminal_id', terminalId)
            .maybeSingle();
          if (!termErr && (termRow as any)?.branch_id) {
            const bid = (termRow as any).branch_id as string;
            try {
              settingsService.setSetting('terminal', 'branch_id', bid);
            } catch { }
            return bid;
          }
        }

        const { data: anyRow, error: err2 } = await supabase
          .from('pos_configurations')
          .select('branch_id')
          .eq('is_active', true)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!err2 && (anyRow as any)?.branch_id) return (anyRow as any).branch_id as string;
      }

      return null;
    } catch (error) {
      console.error('terminal-config:get-branch-id failed:', error);
      return null;
    }
  });

  ipcMain.removeHandler('terminal-config:get-terminal-id');
  ipcMain.handle('terminal-config:get-terminal-id', async () => {
    try {
      if (terminalConfigService) {
        return terminalConfigService.getTerminalId();
      }
      // Persisted settings (from connection string) take priority over env vars
      const persistedTerminalId = settingsService.getSetting<string>('terminal', 'terminal_id', '');
      return persistedTerminalId || process.env.TERMINAL_ID || null;
    } catch (error) {
      console.error('terminal-config:get-terminal-id failed:', error);
      return null;
    }
  });

  ipcMain.removeHandler('terminal-config:refresh');
  ipcMain.handle('terminal-config:refresh', async () => {
    try {
      if (terminalConfigService) {
        await terminalConfigService.refresh();
        const latest = terminalConfigService.getSettings();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal-settings-updated', latest);
        }
        return { success: true, settings: latest };
      }
      const latest = await settingsService.getSettings();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-settings-updated', latest);
      }
      return { success: true, settings: latest };
    } catch (error) {
      console.error('terminal-config:refresh failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Discount settings handlers
  ipcMain.removeHandler('settings:get-discount-max');
  ipcMain.handle('settings:get-discount-max', async () => {
    try {
      const maxPercentage = settingsService.getDiscountMaxPercentage();
      return maxPercentage;
    } catch (error) {
      console.error('Get discount max error:', error);
      return 30;
    }
  });

  ipcMain.removeHandler('settings:set-discount-max');
  ipcMain.handle('settings:set-discount-max', async (_event, percentage: number) => {
    try {
      settingsService.setDiscountMaxPercentage(percentage);
      return { success: true };
    } catch (error) {
      console.error('Set discount max error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Tax settings handlers
  ipcMain.removeHandler('settings:get-tax-rate');
  ipcMain.handle('settings:get-tax-rate', async () => {
    try {
      const taxRate = settingsService.getTaxRatePercentage();
      return taxRate;
    } catch (error) {
      console.error('Get tax rate error:', error);
      return 24;
    }
  });

  ipcMain.removeHandler('settings:set-tax-rate');
  ipcMain.handle('settings:set-tax-rate', async (_event, percentage: number) => {
    try {
      settingsService.setTaxRatePercentage(percentage);
      return { success: true };
    } catch (error) {
      console.error('Set tax rate error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Generic settings setter (for console/debugging)
  ipcMain.removeHandler('settings:set');
  ipcMain.handle('settings:set', async (_event, { category, key, value }) => {
    try {
      const databaseService = dbManager.getDatabaseService();
      databaseService.settings.setSetting(category, key, value);
      console.log(`✅ Setting saved: ${category}.${key} = ${JSON.stringify(value)}`);
      return { success: true, message: `Setting ${category}.${key} saved successfully` };
    } catch (error) {
      console.error('Set setting error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Language settings handlers
  ipcMain.removeHandler('settings:get-language');
  ipcMain.handle('settings:get-language', async () => {
    try {
      const language = settingsService.getLanguage();
      return language;
    } catch (error) {
      console.error('Get language error:', error);
      return 'en';
    }
  });

  ipcMain.removeHandler('settings:set-language');
  ipcMain.handle('settings:set-language', async (_event, language: 'en' | 'el') => {
    try {
      console.log(`[settings:set-language] Setting language to: ${language}`);
      settingsService.setLanguage(language);
      // Update main process i18n instance
      const { updateMainLanguage } = require('../../lib/main-i18n');
      if (updateMainLanguage) {
        updateMainLanguage(language);
        console.log(`[settings:set-language] Main process i18n updated to: ${language}`);
      }
      return { success: true };
    } catch (error) {
      console.error('Set language error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Settings version management handlers
  ipcMain.removeHandler('settings:get-version');
  ipcMain.handle('settings:get-version', async (_event, category: string) => {
    try {
      return settingsService.getSettingsVersion(category as any);
    } catch (error) {
      console.error('Error getting settings version:', error);
      return 0;
    }
  });

  ipcMain.removeHandler('settings:get-all-versions');
  ipcMain.handle('settings:get-all-versions', async () => {
    try {
      return settingsService.getAllSettingsVersions();
    } catch (error) {
      console.error('Error getting all settings versions:', error);
      return {};
    }
  });

  ipcMain.removeHandler('settings:get-sync-status');
  ipcMain.handle('settings:get-sync-status', async () => {
    try {
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
    } catch (error) {
      console.error('Error getting sync status:', error);
      return {};
    }
  });

  ipcMain.removeHandler('settings:force-sync');
  ipcMain.handle('settings:force-sync', async (_event, _category?: string) => {
    try {
      if (adminDashboardSyncService) {
        try {
          await adminDashboardSyncService.forceSync();
        } catch (adminErr) {
          console.warn('Admin settings sync failed (continuing to Supabase sync):', adminErr);
        }
      }

      if (syncService) {
        await syncService.syncAllEnhanced(true);
        await syncService.forceSync(15000);
        return { success: true };
      }
      return { success: false, error: 'Sync service not initialized' };
    } catch (error) {
      console.error('Error forcing sync:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Factory reset handler - clears all local data
  ipcMain.removeHandler('settings:factory-reset');
  ipcMain.handle('settings:factory-reset', async () => {
    try {
      const databaseService = dbManager.getDatabaseService();
      if (!databaseService) {
        return { success: false, error: 'Database service not initialized' };
      }
      
      console.log('[settings:factory-reset] Starting factory reset...');
      await databaseService.factoryReset();
      console.log('[settings:factory-reset] Factory reset completed');
      
      // Notify renderer to reload
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:reset', { reason: 'manual_factory_reset' });
      }
      
      return { success: true };
    } catch (error) {
      console.error('[settings:factory-reset] Factory reset failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Clear operational data handler - clears orders, shifts, drawers, etc. but keeps settings
  ipcMain.removeHandler('database:clear-operational-data');
  ipcMain.handle('database:clear-operational-data', async () => {
    try {
      const databaseService = dbManager.getDatabaseService();
      if (!databaseService) {
        return { success: false, error: 'Database service not initialized' };
      }
      
      console.log('[database:clear-operational-data] Starting operational data clear...');
      await databaseService.clearOperationalData();
      console.log('[database:clear-operational-data] Operational data clear completed');
      
      return { success: true };
    } catch (error) {
      console.error('[database:clear-operational-data] Operational data clear failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Update terminal credentials and trigger sync
  ipcMain.removeHandler('settings:update-terminal-credentials');
  ipcMain.handle(
    'settings:update-terminal-credentials',
    async (
      _event,
      { terminalId, apiKey, adminDashboardUrl }: { terminalId: string; apiKey: string; adminDashboardUrl?: string },
    ) => {
      try {
        if (!adminDashboardSyncService) {
          return { success: false, error: 'Sync service not initialized' };
        }

        // 0) Update the sync service URL if provided (it will handle persisting it after factory reset)
        if (adminDashboardUrl) {
          adminDashboardSyncService.setAdminDashboardUrl(adminDashboardUrl);
          console.log(`[settings:update-terminal-credentials] Admin dashboard URL will be saved: ${adminDashboardUrl}`);
        }

        // 1) Tell AdminDashboardSyncService to update credentials and perform factory reset
        // Pass adminDashboardUrl so it can be saved AFTER the factory reset clears old data
        await adminDashboardSyncService.updateTerminalCredentials(terminalId, apiKey, adminDashboardUrl);

        // 2) Ensure TerminalConfigService switches to the new terminal ID so all
        //    config/branch lookups and realtime subscriptions use the new terminal
        if (terminalConfigService) {
          try {
            await terminalConfigService.switchTerminal(terminalId);
          } catch (err) {
            console.warn(
              '[settings:update-terminal-credentials] Failed to switch TerminalConfigService terminal:',
              err,
            );
          }
        }

        return { success: true };
      } catch (error) {
        console.error('Error updating terminal credentials:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );
}
