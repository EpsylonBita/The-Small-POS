import { ipcMain } from 'electron';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, getSupabaseConfig } from '../../../shared/supabase-config';
import { serviceRegistry } from '../../service-registry';

// Create a service role client for write operations (bypasses RLS)
let serviceRoleClient: SupabaseClient | null = null;

function getServiceRoleClient(): SupabaseClient | null {
  if (!serviceRoleClient) {
    const config = getSupabaseConfig('server');
    if (config.serviceRoleKey) {
      serviceRoleClient = createClient(config.url, config.serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
      console.log('[menu-handlers] Service role client initialized for write operations');
    } else {
      console.warn('[menu-handlers] Service role key not available, falling back to anon key (may fail RLS)');
    }
  }
  return serviceRoleClient;
}

// Get the appropriate client for write operations (prefer service role, fallback to anon)
function getWriteClient(): SupabaseClient {
  return getServiceRoleClient() || getSupabaseClient();
}

const MENU_SYNC_CACHE_TTL_MS = 60_000;
const menuSyncCache = new Map<string, { fetchedAt: number; data: any }>();

type MenuSyncFetchOptions = {
  includeInactive?: boolean;
};

async function fetchMenuSyncData(options: MenuSyncFetchOptions = {}): Promise<any | null> {
  try {
    const includeInactive = !!options.includeInactive;
    const cacheKey = includeInactive ? 'all' : 'active';
    const cached = menuSyncCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < MENU_SYNC_CACHE_TTL_MS) {
      return cached.data;
    }

    const dbSvc = serviceRegistry.dbManager?.getDatabaseService?.();
    const terminalId = (dbSvc?.settings?.getSetting?.('terminal', 'terminal_id', '') || '').toString();
    const apiKey = (dbSvc?.settings?.getSetting?.('terminal', 'pos_api_key', '') || '').toString();
    const adminUrl = (dbSvc?.settings?.getSetting?.('terminal', 'admin_dashboard_url', '') ||
      dbSvc?.settings?.getSetting?.('terminal', 'admin_url', '') ||
      process.env.ADMIN_DASHBOARD_URL || '').toString();

    if (!terminalId || !apiKey || !adminUrl) {
      return null;
    }

    const base = adminUrl.replace(/\/$/, '');
    const url = new URL('/api/pos/menu-sync', base);
    url.searchParams.set('terminal_id', terminalId);
    // Use an old timestamp to force a full payload for management views
    url.searchParams.set('last_sync', '1970-01-01T00:00:00.000Z');
    url.searchParams.set('include_inactive', includeInactive ? 'true' : 'false');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-terminal-id': terminalId,
      'x-pos-api-key': apiKey,
    };

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Menu sync failed: HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.success || !payload?.menu_data) {
      throw new Error(payload?.error || 'Menu sync failed');
    }

    const cacheEntry = { fetchedAt: Date.now(), data: payload.menu_data };
    menuSyncCache.set(cacheKey, cacheEntry);
    return cacheEntry.data;
  } catch (error) {
    console.warn('[menu-handlers] Menu sync fallback failed:', error);
    return null;
  }
}

export function registerMenuHandlers(): void {
  // Remove existing handlers to avoid conflicts
  ipcMain.removeHandler('menu:get-categories');
  ipcMain.removeHandler('menu:get-subcategories');
  ipcMain.removeHandler('menu:get-ingredients');
  ipcMain.removeHandler('menu:get-combos');
  ipcMain.removeHandler('menu:update-category');
  ipcMain.removeHandler('menu:update-subcategory');
  ipcMain.removeHandler('menu:update-ingredient');
  ipcMain.removeHandler('menu:update-combo');

  const mainWindow = serviceRegistry.mainWindow;

  // Get menu categories
  ipcMain.handle('menu:get-categories', async () => {
    try {
      // Prefer admin dashboard menu sync (uses terminal auth, bypasses RLS)
      const menuData = await fetchMenuSyncData({ includeInactive: true });
      const categories = Array.isArray(menuData?.categories) ? menuData.categories : null;
      if (categories) {
        return categories.filter((item: any) => {
          const name = (item.name || item.name_en || '').toLowerCase();
          return !name.includes('rls') && !name.startsWith('test ') && item.is_active !== false;
        });
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('menu_categories')
        .select('*')
        .order('display_order', { ascending: true });

      if (error) throw error;

      // Filter out RLS test data (categories with "RLS" or "test" in the name)
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || item.name_en || '').toLowerCase();
        return !name.includes('rls') && !name.startsWith('test ');
      });

      return filteredData;
    } catch (error) {
      console.error('Error loading categories:', error);
      return [];
    }
  });

  // Get subcategories (menu items) - returns ALL items including inactive for management
  ipcMain.handle('menu:get-subcategories', async () => {
    try {
      // Prefer admin dashboard menu sync (uses terminal auth, bypasses RLS)
      const menuData = await fetchMenuSyncData({ includeInactive: true });
      const subcategories = Array.isArray(menuData?.subcategories) ? menuData.subcategories : null;
      if (subcategories) {
        return subcategories.filter((item: any) => {
          const name = (item.name || '').toLowerCase();
          return !name.includes('rls') && !name.startsWith('test ');
        });
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('subcategories')
        .select('*')
        .order('display_order', { ascending: true });

      if (error) throw error;

      // Filter out RLS test data only, keep inactive items for management
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || '').toLowerCase();
        // Filter out RLS test items only
        return !name.includes('rls') && !name.startsWith('test ');
      });

      return filteredData;
    } catch (error) {
      console.error('Error loading subcategories:', error);
      return [];
    }
  });

  // Get ingredients
  ipcMain.handle('menu:get-ingredients', async () => {
    try {
      // Prefer admin dashboard menu sync (uses terminal auth, bypasses RLS)
      const menuData = await fetchMenuSyncData({ includeInactive: true });
      const ingredients = Array.isArray(menuData?.ingredients) ? menuData.ingredients : null;
      if (ingredients) {
        return ingredients.filter((item: any) => {
          const name = (item.name || '').toLowerCase();
          return !name.includes('rls') && !name.startsWith('test ');
        });
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('ingredients')
        .select('*')
        .order('name', { ascending: true });

      if (error) throw error;

      // Filter out RLS test data
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || '').toLowerCase();
        return !name.includes('rls') && !name.startsWith('test ');
      });

      return filteredData;
    } catch (error) {
      console.error('Error loading ingredients:', error);
      return [];
    }
  });

  // Get combos/offers
  ipcMain.handle('menu:get-combos', async () => {
    try {
      // Prefer admin dashboard menu sync (uses terminal auth, bypasses RLS)
      const menuData = await fetchMenuSyncData({ includeInactive: true });
      const combos = Array.isArray(menuData?.combos) ? menuData.combos : null;
      if (combos) {
        return combos.filter((item: any) => {
          const name = (item.name_en || item.name_el || item.name || '').toLowerCase();
          return !name.includes('rls') && !name.startsWith('test ');
        });
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('menu_combos')
        .select('*')
        .order('display_order', { ascending: true });

      if (error) throw error;

      // Filter out RLS test data
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name_en || item.name_el || '').toLowerCase();
        return !name.includes('rls') && !name.startsWith('test ');
      });

      return filteredData;
    } catch (error) {
      console.error('Error loading combos:', error);
      return [];
    }
  });

  // Update category
  ipcMain.handle('menu:update-category', async (_event, params: { id: string; is_active: boolean }) => {
    try {
      // Use service role client to bypass RLS for write operations
      const supabase = getWriteClient();
      const { error } = await supabase
        .from('menu_categories')
        .update({
          is_active: params.is_active,
          updated_at: new Date().toISOString()
        })
        .eq('id', params.id);

      if (error) throw error;

      // Notify renderer of the change
      const currentMainWindow = serviceRegistry.mainWindow;
      if (currentMainWindow && !currentMainWindow.isDestroyed()) {
        currentMainWindow.webContents.send('menu:sync', {
          table: 'menu_categories',
          action: 'update',
          id: params.id
        });
      }

      return { success: true };
    } catch (error) {
      console.error('Error updating category:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update category' };
    }
  });

  // Update subcategory (menu item)
  ipcMain.handle('menu:update-subcategory', async (_event, params: { id: string; is_available: boolean }) => {
    try {
      // Use service role client to bypass RLS for write operations
      const supabase = getWriteClient();
      const { error } = await supabase
        .from('subcategories')
        .update({
          is_available: params.is_available,
          updated_at: new Date().toISOString()
        })
        .eq('id', params.id);

      if (error) throw error;

      // Notify renderer of the change
      const currentMainWindow = serviceRegistry.mainWindow;
      if (currentMainWindow && !currentMainWindow.isDestroyed()) {
        currentMainWindow.webContents.send('menu:sync', {
          table: 'subcategories',
          action: 'update',
          id: params.id
        });
      }

      return { success: true };
    } catch (error) {
      console.error('Error updating subcategory:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update subcategory' };
    }
  });

  // Update ingredient
  ipcMain.handle('menu:update-ingredient', async (_event, params: { id: string; is_available: boolean }) => {
    try {
      console.log('[menu:update-ingredient] Updating ingredient:', params);

      // Use service role client to bypass RLS for write operations
      const supabase = getWriteClient();
      const { data, error, count } = await supabase
        .from('ingredients')
        .update({
          is_available: params.is_available,
          updated_at: new Date().toISOString()
        })
        .eq('id', params.id)
        .select();

      if (error) {
        console.error('[menu:update-ingredient] Supabase error:', error);
        throw error;
      }

      // Check if any rows were actually updated
      if (!data || data.length === 0) {
        console.warn('[menu:update-ingredient] No rows updated - ingredient may not exist or ID mismatch');
        return { success: false, error: 'Ingredient not found or no changes made' };
      }

      console.log('[menu:update-ingredient] Successfully updated:', data);

      // Notify renderer of the change
      const currentMainWindow = serviceRegistry.mainWindow;
      if (currentMainWindow && !currentMainWindow.isDestroyed()) {
        currentMainWindow.webContents.send('menu:sync', {
          table: 'ingredients',
          action: 'update',
          id: params.id,
          data: data[0]
        });
      }

      return { success: true, data: data[0] };
    } catch (error) {
      console.error('[menu:update-ingredient] Error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update ingredient' };
    }
  });

  // Update combo/offer
  ipcMain.handle('menu:update-combo', async (_event, params: { id: string; is_active: boolean }) => {
    try {
      const supabase = getWriteClient();
      const { data, error } = await supabase
        .from('menu_combos')
        .update({
          is_active: params.is_active,
          updated_at: new Date().toISOString()
        })
        .eq('id', params.id)
        .select();

      if (error) throw error;

      if (!data || data.length === 0) {
        return { success: false, error: 'Combo not found or no changes made' };
      }

      // Notify renderer of the change
      const currentMainWindow = serviceRegistry.mainWindow;
      if (currentMainWindow && !currentMainWindow.isDestroyed()) {
        currentMainWindow.webContents.send('menu:sync', {
          table: 'menu_combos',
          action: 'update',
          id: params.id,
          data: data[0]
        });
      }

      return { success: true, data: data[0] };
    } catch (error) {
      console.error('Error updating combo:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update combo' };
    }
  });

  // Handle menu-triggered check for updates
  ipcMain.removeHandler('menu:trigger-check-for-updates');
  ipcMain.handle('menu:trigger-check-for-updates', () => {
    const currentMainWindow = serviceRegistry.mainWindow;
    if (currentMainWindow && !currentMainWindow.isDestroyed()) {
      // Send the event that useAutoUpdater listens for
      currentMainWindow.webContents.send('menu:check-for-updates');
      console.log('[menu-handlers] Sent menu:check-for-updates event');
    }
    return { success: true };
  });

  // Setup real-time subscriptions for menu changes from admin dashboard
  const setupMenuRealtimeSync = () => {
    try {
      const supabase = getSupabaseClient();
      
      const channel = supabase
        .channel('pos-menu-sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_categories' }, (payload) => {
          console.log('📡 Menu category changed:', payload);
          const currentMainWindow = serviceRegistry.mainWindow;
          if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('menu:sync', {
              table: 'menu_categories',
              action: payload.eventType,
              data: payload.new || payload.old
            });
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'subcategories' }, (payload) => {
          console.log('📡 Subcategory changed:', payload);
          const currentMainWindow = serviceRegistry.mainWindow;
          if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('menu:sync', {
              table: 'subcategories',
              action: payload.eventType,
              data: payload.new || payload.old
            });
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ingredients' }, (payload) => {
          console.log('📡 Ingredient changed:', payload);
          const currentMainWindow = serviceRegistry.mainWindow;
          if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('menu:sync', {
              table: 'ingredients',
              action: payload.eventType,
              data: payload.new || payload.old
            });
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_combos' }, (payload) => {
          console.log('📡 Combo changed:', payload);
          const currentMainWindow = serviceRegistry.mainWindow;
          if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('menu:sync', {
              table: 'menu_combos',
              action: payload.eventType,
              data: payload.new || payload.old
            });
          }
        })
        .subscribe((status) => {
          console.log('📡 POS menu sync subscription status:', status);
        });

      return () => {
        console.log('🧹 Cleaning up POS menu sync subscription');
        supabase.removeChannel(channel);
      };
    } catch (error) {
      console.error('Error setting up menu realtime sync:', error);
      return () => {};
    }
  };

  // Start real-time sync
  setupMenuRealtimeSync();
}
