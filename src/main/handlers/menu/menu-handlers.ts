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

export function registerMenuHandlers(): void {
  // Remove existing handlers to avoid conflicts
  ipcMain.removeHandler('menu:get-categories');
  ipcMain.removeHandler('menu:get-subcategories');
  ipcMain.removeHandler('menu:get-ingredients');
  ipcMain.removeHandler('menu:update-category');
  ipcMain.removeHandler('menu:update-subcategory');
  ipcMain.removeHandler('menu:update-ingredient');

  const mainWindow = serviceRegistry.mainWindow;

  // Get menu categories
  ipcMain.handle('menu:get-categories', async () => {
    try {
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
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('ingredients')
        .select('*')
        .order('name_en', { ascending: true });

      if (error) throw error;

      // Filter out RLS test data
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || item.name_en || '').toLowerCase();
        return !name.includes('rls') && !name.startsWith('test ');
      });

      return filteredData;
    } catch (error) {
      console.error('Error loading ingredients:', error);
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
  ipcMain.handle('menu:update-ingredient', async (_event, params: { id: string; is_active: boolean }) => {
    try {
      console.log('[menu:update-ingredient] Updating ingredient:', params);

      // Use service role client to bypass RLS for write operations
      const supabase = getWriteClient();
      const { data, error, count } = await supabase
        .from('ingredients')
        .update({
          is_active: params.is_active,
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
