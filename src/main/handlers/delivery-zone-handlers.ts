/**
 * Delivery Zone Handlers Module
 *
 * Handles delivery zone validation and analytics IPC.
 */

import { ipcMain, Notification } from 'electron';
import { serviceRegistry } from '../service-registry';
import { getSupabaseClient } from '../../shared/supabase-config';

/**
 * Register delivery zone IPC handlers
 */
export function registerDeliveryZoneHandlers(): void {
  /**
   * Track delivery validation attempt to analytics
   */
  ipcMain.handle(
    'delivery-zone:track-validation',
    async (
      event,
      data: {
        zoneId?: string;
        address: string;
        coordinates?: { lat: number; lng: number };
        result: string;
        orderAmount?: number;
        deliveryFee?: number;
        source: string;
        terminalId?: string;
        staffId?: string;
        overrideApplied?: boolean;
        overrideReason?: string;
        responseTimeMs: number;
        timestamp: string;
      }
    ) => {
      try {
        const supabase = getSupabaseClient();
        const terminalConfigService = serviceRegistry.terminalConfigService;

        if (!supabase) {
          return { success: false, error: 'Supabase client not available' };
        }

        // Insert validation log
        const { data: logData, error: logError } = await supabase
          .from('delivery_validation_logs')
          .insert({
            zone_id: data.zoneId || null,
            address: data.address,
            coordinates: data.coordinates || null,
            validation_result: data.result,
            order_amount: data.orderAmount || null,
            delivery_fee: data.deliveryFee || null,
            source: data.source,
            terminal_id:
              data.terminalId ?? (terminalConfigService ? terminalConfigService.getTerminalId() : null),
            staff_id: data.staffId || null,
            override_applied: data.overrideApplied || false,
            override_reason: data.overrideReason || null,
            response_time_ms: data.responseTimeMs,
          })
          .select()
          .single();

        if (logError) {
          console.error('Error tracking validation:', logError);
          return { success: false, error: logError.message, aggregated: false };
        }

        // Aggregate analytics if zone_id is provided
        let aggregated = false;
        if (data.zoneId) {
          try {
            const currentDate = new Date().toISOString().slice(0, 10);
            const { error: rpcError } = await supabase.rpc('aggregate_zone_analytics', {
              p_zone_id: data.zoneId,
              p_date: currentDate,
              p_period_type: 'daily',
            });

            if (rpcError) {
              console.error('Error aggregating zone analytics:', rpcError);
              // Don't fail the entire operation if aggregation fails
            } else {
              aggregated = true;
            }
          } catch (aggError) {
            console.error('Exception during analytics aggregation:', aggError);
            // Continue despite aggregation error
          }
        }

        return { success: true, data: logData, aggregated };
      } catch (error) {
        console.error('Track delivery validation error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to track validation',
          aggregated: false,
        };
      }
    }
  );

  /**
   * Get delivery zone analytics
   */
  ipcMain.handle(
    'delivery-zone:get-analytics',
    async (
      event,
      filters?: {
        zoneId?: string;
        dateFrom?: string;
        dateTo?: string;
        periodType?: string;
      }
    ) => {
      try {
        const supabase = getSupabaseClient();
        if (!supabase) {
          return { success: false, error: 'Supabase client not available' };
        }

        let query = supabase.from('delivery_zone_analytics').select('*');

        if (filters?.zoneId) {
          query = query.eq('zone_id', filters.zoneId);
        }

        if (filters?.dateFrom) {
          query = query.gte('date_period', filters.dateFrom);
        }

        if (filters?.dateTo) {
          query = query.lte('date_period', filters.dateTo);
        }

        if (filters?.periodType) {
          query = query.eq('period_type', filters.periodType);
        }

        const { data, error } = await query.order('date_period', { ascending: false });

        if (error) {
          console.error('Error fetching analytics:', error);
          return { success: false, error: error.message };
        }

        return { success: true, data };
      } catch (error) {
        console.error('Get delivery zone analytics error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get analytics',
        };
      }
    }
  );

  /**
   * Show system notification
   */
  ipcMain.handle(
    'notification:show',
    async (
      event,
      notification: {
        title: string;
        body: string;
        type?: 'info' | 'warning' | 'error';
      }
    ) => {
      try {
        if (Notification.isSupported()) {
          const notif = new Notification({
            title: notification.title,
            body: notification.body,
            // Could add icons later based on type
          });
          notif.show();
        }

        return { success: true };
      } catch (error) {
        console.error('Show notification error:', error);
        return { success: false, error: 'Failed to show notification' };
      }
    }
  );
}
