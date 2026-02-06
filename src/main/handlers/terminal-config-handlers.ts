/**
 * Terminal Config Handlers Module
 *
 * Handles terminal configuration IPC.
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../service-registry';
import { getSupabaseClient } from '../../shared/supabase-config';

/**
 * Register terminal configuration IPC handlers
 */
export function registerTerminalConfigHandlers(): void {
  // Terminal configuration handlers (registered once at top-level)
  // Guard with removeHandler to avoid duplicate-registration errors.
  ipcMain.removeHandler('terminal-config:get-settings');
  ipcMain.handle('terminal-config:get-settings', async () => {
    try {
      const terminalConfigService = serviceRegistry.terminalConfigService;
      const settingsService = serviceRegistry.settingsService;

      if (terminalConfigService) {
        return terminalConfigService.getSettings();
      }
      // Fallback to settingsService if terminalConfigService not initialized
      if (settingsService) {
        return await settingsService.getSettings();
      }
      return {};
    } catch (error) {
      console.error('terminal-config:get-settings failed:', error);
      return {};
    }
  });

  ipcMain.removeHandler('terminal-config:get-setting');
  ipcMain.handle('terminal-config:get-setting', async (_event, category: string, key: string) => {
    try {
      const terminalConfigService = serviceRegistry.terminalConfigService;
      const dbManager = serviceRegistry.dbManager;

      if (terminalConfigService) {
        // Use dot notation for nested keys
        const fullKey = category && key ? `${category}.${key}` : key || category;
        return terminalConfigService.getSetting(fullKey, null);
      }
      // Fallback to database service
      if (dbManager) {
        const svc = dbManager.getDatabaseService().settings;
        return svc.getSetting(category as any, key, null);
      }
      return null;
    } catch (error) {
      console.error('terminal-config:get-setting failed:', error);
      return null;
    }
  });

  // Expose branch id directly for renderer where needed (e.g., scoping staff list)
  ipcMain.removeHandler('terminal-config:get-branch-id');
  ipcMain.handle('terminal-config:get-branch-id', async () => {
    try {
      const terminalConfigService = serviceRegistry.terminalConfigService;
      const settingsService = serviceRegistry.settingsService;

      // 1) Prefer cached service value
      if (terminalConfigService) {
        const bid = terminalConfigService.getBranchId();
        if (bid) return bid;
      }

      // 2) Check locally persisted setting
      try {
        const saved = settingsService?.getSetting?.('terminal', 'branch_id', null) as string | null;
        if (saved) return saved as string;
      } catch {
        // Continue
      }

      const persistedTerminalId = settingsService?.getSetting<string>('terminal', 'terminal_id', '');
      const terminalId = process.env.TERMINAL_ID || persistedTerminalId || null;

      // 3) Try Admin Dashboard POS Settings API (authoritative source created by Admin)
      if (terminalId) {
        try {
          const apiKey =
            (settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string) || '';
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
                json?.branch_id ||
                json?.settings?.terminal?.branch_id ||
                json?.settings?.terminal?.branchId ||
                null;
              if (bidFromAdmin) {
                try {
                  settingsService?.setSetting('terminal', 'branch_id', bidFromAdmin);
                } catch {
                  // Continue
                }
                return bidFromAdmin as string;
              }
            }
          }
        } catch (e) {
          console.warn(
            '[main] Admin POS Settings fetch failed for branch resolution:',
            (e as any)?.message || e
          );
        }
      }

      // 4) Fallbacks via Supabase
      const supabase = getSupabaseClient();
      if (supabase) {
        // 4a) Try pos_configurations (if schema includes branch_id)
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

        // 4b) Try pos_terminals authoritative mapping
        if (terminalId) {
          const { data: termRow, error: termErr } = await supabase
            .from('pos_terminals')
            .select('branch_id')
            .eq('terminal_id', terminalId)
            .maybeSingle();
          if (!termErr && (termRow as any)?.branch_id) {
            const bid = (termRow as any).branch_id as string;
            try {
              settingsService?.setSetting('terminal', 'branch_id', bid);
            } catch {
              // Continue
            }
            return bid;
          }
        }

        // 4c) Last resort: pick most recent active config regardless of terminal
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

  // Expose terminal id directly (used by shift restore)
  ipcMain.removeHandler('terminal-config:get-terminal-id');
  ipcMain.handle('terminal-config:get-terminal-id', async () => {
    try {
      const terminalConfigService = serviceRegistry.terminalConfigService;
      const settingsService = serviceRegistry.settingsService;

      if (terminalConfigService) {
        const tid = terminalConfigService.getTerminalId();
        console.log('[terminal-config:get-terminal-id] From TerminalConfigService:', tid);
        return tid;
      }
      // Fallback to persisted setting / env - PERSISTED TAKES PRIORITY
      const persistedTerminalId = settingsService?.getSetting<string>('terminal', 'terminal_id', '');
      const result = persistedTerminalId || process.env.TERMINAL_ID || null;
      console.log('[terminal-config:get-terminal-id] Fallback result:', result, 'source:', persistedTerminalId ? 'settings' : 'env');
      return result;
    } catch (error) {
      console.error('terminal-config:get-terminal-id failed:', error);
      return null;
    }
  });

  // Expose organization id directly for module resolution
  ipcMain.removeHandler('terminal-config:get-organization-id');
  ipcMain.handle('terminal-config:get-organization-id', async () => {
    try {
      const terminalConfigService = serviceRegistry.terminalConfigService;
      if (terminalConfigService) {
        return terminalConfigService.getOrganizationId() || null;
      }
      return null;
    } catch (error) {
      console.error('terminal-config:get-organization-id failed:', error);
      return null;
    }
  });

  // Expose business type directly for module resolution
  ipcMain.removeHandler('terminal-config:get-business-type');
  ipcMain.handle('terminal-config:get-business-type', async () => {
    try {
      const terminalConfigService = serviceRegistry.terminalConfigService;
      if (terminalConfigService) {
        return terminalConfigService.getBusinessType() || null;
      }
      return null;
    } catch (error) {
      console.error('terminal-config:get-business-type failed:', error);
      return null;
    }
  });

  ipcMain.removeHandler('terminal-config:refresh');
  ipcMain.handle('terminal-config:refresh', async () => {
    try {
      const terminalConfigService = serviceRegistry.terminalConfigService;
      const settingsService = serviceRegistry.settingsService;
      const mainWindow = serviceRegistry.mainWindow;

      if (terminalConfigService) {
        await terminalConfigService.refresh();
        const latest = terminalConfigService.getSettings();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal-settings-updated', latest);
        }
        return { success: true, settings: latest };
      }
      // Fallback
      if (settingsService) {
        const latest = await settingsService.getSettings();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal-settings-updated', latest);
        }
        return { success: true, settings: latest };
      }
      return { success: false, error: 'Services not initialized' };
    } catch (error) {
      console.error('terminal-config:refresh failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // =========================================================================
  // Feature Flag Handlers for Mobile Waiter Terminal Support
  // =========================================================================

  /**
   * Get terminal type ('main' or 'mobile_waiter')
   */
  ipcMain.removeHandler('terminal-config:get-terminal-type');
  ipcMain.handle('terminal-config:get-terminal-type', async () => {
    try {
      const featureService = serviceRegistry.featureService;
      if (featureService) {
        return featureService.getTerminalType();
      }
      // Fallback to settings service
      const settingsService = serviceRegistry.settingsService;
      if (settingsService) {
        return settingsService.getTerminalType();
      }
      return 'main'; // Default to main terminal
    } catch (error) {
      console.error('terminal-config:get-terminal-type failed:', error);
      return 'main';
    }
  });

  /**
   * Get parent terminal ID (for mobile waiter terminals)
   */
  ipcMain.removeHandler('terminal-config:get-parent-terminal-id');
  ipcMain.handle('terminal-config:get-parent-terminal-id', async () => {
    try {
      const featureService = serviceRegistry.featureService;
      if (featureService) {
        return featureService.getParentTerminalId();
      }
      // Fallback to settings service
      const settingsService = serviceRegistry.settingsService;
      if (settingsService) {
        return settingsService.getParentTerminalId();
      }
      return null;
    } catch (error) {
      console.error('terminal-config:get-parent-terminal-id failed:', error);
      return null;
    }
  });

  /**
   * Get all enabled features
   */
  ipcMain.removeHandler('terminal-config:get-enabled-features');
  ipcMain.handle('terminal-config:get-enabled-features', async () => {
    try {
      const featureService = serviceRegistry.featureService;
      if (featureService) {
        return featureService.getFeatures();
      }
      // Fallback to settings service
      const settingsService = serviceRegistry.settingsService;
      if (settingsService) {
        const features = settingsService.getEnabledFeatures();
        // Return default features if none are set
        if (!features || Object.keys(features).length === 0) {
          return {
            cashDrawer: true,
            zReportExecution: true,
            cashPayments: true,
            cardPayments: true,
            orderCreation: true,
            orderModification: true,
            discounts: true,
            refunds: true,
            expenses: true,
            staffPayments: true,
            reports: true,
            settings: true,
          };
        }
        return features;
      }
      // Default to all features enabled for main terminal
      return {
        cashDrawer: true,
        zReportExecution: true,
        cashPayments: true,
        cardPayments: true,
        orderCreation: true,
        orderModification: true,
        discounts: true,
        refunds: true,
        expenses: true,
        staffPayments: true,
        reports: true,
        settings: true,
      };
    } catch (error) {
      console.error('terminal-config:get-enabled-features failed:', error);
      // Return default features on error
      return {
        cashDrawer: true,
        zReportExecution: true,
        cashPayments: true,
        cardPayments: true,
        orderCreation: true,
        orderModification: true,
        discounts: true,
        refunds: true,
        expenses: true,
        staffPayments: true,
        reports: true,
        settings: true,
      };
    }
  });

  /**
   * Check if a specific feature is enabled
   */
  ipcMain.removeHandler('terminal-config:is-feature-enabled');
  ipcMain.handle('terminal-config:is-feature-enabled', async (_event, featureName: string) => {
    try {
      const featureService = serviceRegistry.featureService;
      if (featureService) {
        return featureService.isFeatureEnabled(featureName as any);
      }
      // Fallback to settings service
      const settingsService = serviceRegistry.settingsService;
      if (settingsService) {
        const features = settingsService.getEnabledFeatures();
        if (features && typeof features[featureName] === 'boolean') {
          return features[featureName];
        }
      }
      // Default to enabled for main terminal
      return true;
    } catch (error) {
      console.error('terminal-config:is-feature-enabled failed:', error);
      return true; // Default to enabled on error
    }
  });

  /**
   * Get full terminal configuration (type, parent, and features)
   */
  ipcMain.removeHandler('terminal-config:get-full-config');
  ipcMain.handle('terminal-config:get-full-config', async () => {
    try {
      const featureService = serviceRegistry.featureService;
      if (featureService) {
        return featureService.getTerminalConfig();
      }
      // Fallback to settings service
      const settingsService = serviceRegistry.settingsService;
      if (settingsService) {
        return {
          terminalType: settingsService.getTerminalType() || 'main',
          parentTerminalId: settingsService.getParentTerminalId(),
          features: settingsService.getEnabledFeatures() || {
            cashDrawer: true,
            zReportExecution: true,
            cashPayments: true,
            cardPayments: true,
            orderCreation: true,
            orderModification: true,
            discounts: true,
            refunds: true,
            expenses: true,
            staffPayments: true,
            reports: true,
            settings: true,
          },
        };
      }
      // Return default config
      return {
        terminalType: 'main',
        parentTerminalId: null,
        features: {
          cashDrawer: true,
          zReportExecution: true,
          cashPayments: true,
          cardPayments: true,
          orderCreation: true,
          orderModification: true,
          discounts: true,
          refunds: true,
          expenses: true,
          staffPayments: true,
          reports: true,
          settings: true,
        },
      };
    } catch (error) {
      console.error('terminal-config:get-full-config failed:', error);
      return {
        terminalType: 'main',
        parentTerminalId: null,
        features: {
          cashDrawer: true,
          zReportExecution: true,
          cashPayments: true,
          cardPayments: true,
          orderCreation: true,
          orderModification: true,
          discounts: true,
          refunds: true,
          expenses: true,
          staffPayments: true,
          reports: true,
          settings: true,
        },
      };
    }
  });
}
