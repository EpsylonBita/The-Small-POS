import { ipcMain } from 'electron';
import { getSupabaseClient } from '../../../shared/supabase-config';
import { serviceRegistry } from '../../service-registry';
import { isConflictResult } from '../../../shared/types/customer-sync';

export function registerCustomerHandlers(): void {
  const customerService = serviceRegistry.customerService;
  const mainWindow = serviceRegistry.mainWindow;

  ipcMain.handle('customer:invalidate-cache', async (_event, phone: string) => {
    try {
      if (!customerService) return { success: false, error: 'Customer service not available' };
      customerService.invalidateCache(phone);
      return { success: true };
    } catch (error) {
      console.error('Customer invalidate cache error:', error);
      return { success: false, error: 'Failed to invalidate customer cache' };
    }
  });

  ipcMain.handle('customer:get-cache-stats', async () => {
    try {
      if (!customerService) return { total: 0, expired: 0, valid: 0 };
      return customerService.getCacheStats();
    } catch (error) {
      console.error('Customer get cache stats error:', error);
      return { total: 0, expired: 0, valid: 0 };
    }
  });

  ipcMain.handle('customer:clear-cache', async () => {
    try {
      if (!customerService) return { success: false, error: 'Customer service not available' };
      customerService.clearExpiredCache();
      return { success: true };
    } catch (error) {
      console.error('Customer clear cache error:', error);
      return { success: false, error: 'Failed to clear customer cache' };
    }
  });

  ipcMain.handle('customer:lookup-by-phone', async (_event, phone: string) => {
    try {
      if (!customerService) return null;
      return await customerService.lookupByPhone(phone);
    } catch (error) {
      console.error('Customer lookup error:', error);
      return null;
    }
  });

  ipcMain.handle('customer:search', async (_event, query: string) => {
    try {
      if (!customerService) return [];
      return await customerService.searchCustomers(query);
    } catch (error) {
      console.error('Customer search error:', error);
      return [];
    }
  });

  // Lookup customer by ID - used for address resolution fallback in order creation
  ipcMain.handle('customer:lookup-by-id', async (_event, customerId: string) => {
    try {
      if (!customerId) return null;
      const dbManager = serviceRegistry.dbManager;
      if (!dbManager) {
        console.warn('[customer:lookup-by-id] DatabaseManager not available');
        return null;
      }
      console.log('[customer:lookup-by-id] Looking up customer:', customerId);
      const customer = await dbManager.getCustomerById(customerId);
      console.log('[customer:lookup-by-id] Found customer:', customer ? { id: customer.id, hasAddress: !!customer.address, hasAddresses: Array.isArray(customer.addresses) && customer.addresses.length > 0 } : null);
      return customer;
    } catch (error) {
      console.error('Customer lookup by ID error:', error);
      return null;
    }
  });

  ipcMain.handle('customer:create', async (_event, data: any) => {
    try {
      if (!customerService) return { success: false, error: 'Customer service not available' };
      const created = await customerService.createCustomer(data);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('customer-created', {
          eventType: 'INSERT',
          table: 'customers',
          new: created,
          old: null,
        });
      }
      return { success: true, data: created };
    } catch (error) {
      console.error('Customer create error:', error);
      const message = error instanceof Error ? error.message : 'Failed to create customer';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('customer:update', async (_event, customerId: string, updates: any, currentVersion: number) => {
    try {
      if (!customerService) return { success: false, error: 'Customer service not available' };
      const result = await customerService.updateCustomer(customerId, updates, currentVersion);
      if (isConflictResult(result as any)) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('customer-sync-conflict', {
            eventType: 'CONFLICT',
            table: 'customers',
            new: result,
            old: null,
          });
        }
        return { success: false, conflict: true, data: result };
      }
      if (result && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('customer-updated', {
          eventType: 'UPDATE',
          table: 'customers',
          new: result,
          old: null,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      console.error('Customer update error:', error);
      const message = error instanceof Error ? error.message : 'Failed to update customer';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('customer:update-ban-status', async (_event, customerId: string, isBanned: boolean) => {
    try {
      if (!customerService) return { success: false, error: 'Customer service not available' };
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('customers')
        .update({ is_banned: isBanned })
        .eq('id', customerId)
        .select()
        .single();
      if (error) throw error;
      if (data && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('customer-updated', {
          eventType: 'UPDATE',
          table: 'customers',
          new: data,
          old: null,
        });
      }
      return { success: true, data };
    } catch (error) {
      console.error('Customer update ban status error:', error);
      const message = error instanceof Error ? error.message : 'Failed to update ban status';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('customer:add-address', async (_event, customerId: string, address: any) => {
    try {
      if (!customerService) return { success: false, error: 'Customer service not available' };
      const created = await customerService.addAddress(customerId, address);
      if (created && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('customer-updated', {
          eventType: 'UPDATE',
          table: 'customers',
          new: { id: customerId, address_added: created },
          old: null,
        });
      }
      return { success: true, data: created };
    } catch (error) {
      console.error('Customer add address error:', error);
      const message = error instanceof Error ? error.message : 'Failed to add address';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('customer:update-address', async (_event, addressId: string, updates: any, currentVersion: number) => {
    try {
      if (!customerService) return { success: false, error: 'Customer service not available' };
      const result = await customerService.updateAddress(addressId, updates, currentVersion);
      if (isConflictResult(result as any)) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('customer-sync-conflict', {
            eventType: 'CONFLICT',
            table: 'customer_addresses',
            new: result,
            old: null,
          });
        }
        return { success: false, conflict: true, data: result };
      }
      if (result && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('customer-updated', {
          eventType: 'UPDATE',
          table: 'customer_addresses',
          new: result,
          old: null,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      console.error('Customer update address error:', error);
      const message = error instanceof Error ? error.message : 'Failed to update address';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('customer:resolve-conflict', async (_event, conflictId: string, strategy: string, data?: any) => {
    try {
      if (!customerService) return { success: false, error: 'Customer service not available' };
      const result = await (customerService as any).resolveCustomerConflict(conflictId, strategy, data);
      if (result && result.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('customer-conflict-resolved', {
          eventType: 'RESOLVED',
          table: 'customers',
          conflictId,
          new: result.resolvedCustomer,
          old: null,
        });
      }
      return {
        success: result?.success || false,
        data: result?.resolvedCustomer,
        error: result?.error,
      };
    } catch (error) {
      console.error('Customer resolve conflict error:', error);
      const message = error instanceof Error ? error.message : 'Failed to resolve conflict';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('customer:get-conflicts', async (_event, filters?: any) => {
    try {
      if (!customerService) return { success: true, data: [] };
      const conflicts = await (customerService as any).getCustomerConflicts(filters);
      return { success: true, data: conflicts };
    } catch (error) {
      console.error('Customer get conflicts error:', error);
      const message = error instanceof Error ? error.message : 'Failed to get conflicts';
      return { success: false, error: message, data: [] };
    }
  });
}
