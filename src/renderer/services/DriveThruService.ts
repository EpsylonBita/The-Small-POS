/**
 * DriveThruService - POS Drive-Through Service
 * 
 * Provides drive-through lane and order queue management for the POS system (Fast-food Vertical).
 * Uses direct Supabase connection for real-time data.
 * 
 * Task 17.3: Create POS drive-through interface
 */

import { supabase, subscribeToTable, unsubscribeFromChannel } from '../../shared/supabase';

// Types
export type DriveThruOrderStatus = 'waiting' | 'preparing' | 'ready' | 'served';

export interface DriveThruLane {
  id: string;
  organizationId: string;
  branchId: string;
  laneNumber: number;
  name: string;
  isActive: boolean;
  currentOrderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DriveThruOrder {
  id: string;
  organizationId: string;
  branchId: string;
  laneId: string;
  orderId: string;
  orderNumber: string | null;
  customerName: string | null;
  itemsCount: number;
  position: number;
  status: DriveThruOrderStatus;
  arrivedAt: string;
  servedAt: string | null;
  waitTimeSeconds: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DriveThruStats {
  totalLanes: number;
  activeLanes: number;
  ordersInQueue: number;
  averageWaitTimeSeconds: number;
  ordersServedToday: number;
}

// Transform lane from API
function transformLaneFromAPI(data: any): DriveThruLane {
  return {
    id: data.id,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    laneNumber: data.lane_number,
    name: data.name,
    isActive: data.is_active ?? true,
    currentOrderId: data.current_order_id,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

// Transform order from API
function transformOrderFromAPI(data: any): DriveThruOrder {
  return {
    id: data.id,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    laneId: data.lane_id,
    orderId: data.order_id,
    orderNumber: data.order_number || data.orders?.order_number || `DT-${data.id.slice(-4).toUpperCase()}`,
    customerName: data.customer_name || data.orders?.customer_name || null,
    itemsCount: data.items_count || data.orders?.items_count || 0,
    position: data.position || 0,
    status: data.status || 'waiting',
    arrivedAt: data.arrived_at,
    servedAt: data.served_at,
    waitTimeSeconds: data.wait_time_seconds,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

class DriveThruService {
  private branchId: string = '';
  private organizationId: string = '';
  private lanesChannel: any = null;
  private ordersChannel: any = null;

  /**
   * Set the current branch and organization context
   */
  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
  }

  /**
   * Fetch all lanes for the branch
   */
  async fetchLanes(): Promise<DriveThruLane[]> {
    try {
      const { data, error } = await supabase
        .from('drive_thru_lanes')
        .select('*')
        .eq('branch_id', this.branchId)
        .order('lane_number', { ascending: true });

      if (error) {
        console.error('Error fetching drive-thru lanes:', error);
        throw error;
      }

      return (data || []).map(transformLaneFromAPI);
    } catch (error) {
      console.error('Failed to fetch lanes:', error);
      return [];
    }
  }

  /**
   * Fetch all orders in the queue
   */
  async fetchOrders(laneId?: string): Promise<DriveThruOrder[]> {
    try {
      let query = supabase
        .from('drive_thru_orders')
        .select(`
          *,
          orders:order_id(order_number, customer_name, items_count)
        `)
        .eq('branch_id', this.branchId)
        .neq('status', 'served')
        .order('position', { ascending: true });

      if (laneId) {
        query = query.eq('lane_id', laneId);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching drive-thru orders:', error);
        throw error;
      }

      return (data || []).map(transformOrderFromAPI);
    } catch (error) {
      console.error('Failed to fetch orders:', error);
      return [];
    }
  }

  /**
   * Update order status (move through stages)
   */
  async updateOrderStatus(orderId: string, status: DriveThruOrderStatus): Promise<DriveThruOrder> {
    try {
      const updateData: any = {
        status,
        updated_at: new Date().toISOString(),
      };

      // If marking as served, set served_at and calculate wait time
      if (status === 'served') {
        const { data: currentOrder } = await supabase
          .from('drive_thru_orders')
          .select('arrived_at')
          .eq('id', orderId)
          .single();

        if (currentOrder?.arrived_at) {
          const arrivedAt = new Date(currentOrder.arrived_at);
          const servedAt = new Date();
          updateData.served_at = servedAt.toISOString();
          updateData.wait_time_seconds = Math.round((servedAt.getTime() - arrivedAt.getTime()) / 1000);
        }
      }

      const { data: order, error } = await supabase
        .from('drive_thru_orders')
        .update(updateData)
        .eq('id', orderId)
        .select()
        .single();

      if (error) {
        console.error('Error updating order status:', error);
        throw error;
      }

      return transformOrderFromAPI(order);
    } catch (error) {
      console.error('Failed to update order status:', error);
      throw error;
    }
  }

  /**
   * Move order to next stage
   */
  async moveToNextStage(orderId: string, currentStatus: DriveThruOrderStatus): Promise<DriveThruOrder> {
    const statusOrder: DriveThruOrderStatus[] = ['waiting', 'preparing', 'ready', 'served'];
    const currentIndex = statusOrder.indexOf(currentStatus);
    const nextStatus = statusOrder[Math.min(currentIndex + 1, statusOrder.length - 1)];
    return this.updateOrderStatus(orderId, nextStatus);
  }

  /**
   * Move order to previous stage
   */
  async moveToPrevStage(orderId: string, currentStatus: DriveThruOrderStatus): Promise<DriveThruOrder> {
    const statusOrder: DriveThruOrderStatus[] = ['waiting', 'preparing', 'ready', 'served'];
    const currentIndex = statusOrder.indexOf(currentStatus);
    const prevStatus = statusOrder[Math.max(currentIndex - 1, 0)];
    return this.updateOrderStatus(orderId, prevStatus);
  }

  /**
   * Calculate statistics
   */
  calculateStats(lanes: DriveThruLane[], orders: DriveThruOrder[]): DriveThruStats {
    const activeOrders = orders.filter(o => o.status !== 'served');
    const servedOrders = orders.filter(o => o.status === 'served' && o.waitTimeSeconds);

    const avgWaitTime = servedOrders.length > 0
      ? Math.round(servedOrders.reduce((sum, o) => sum + (o.waitTimeSeconds || 0), 0) / servedOrders.length)
      : 0;

    return {
      totalLanes: lanes.length,
      activeLanes: lanes.filter(l => l.isActive).length,
      ordersInQueue: activeOrders.length,
      averageWaitTimeSeconds: avgWaitTime,
      ordersServedToday: servedOrders.length,
    };
  }

  /**
   * Get elapsed time string from timestamp
   */
  getElapsedTime(arrivedAt: string): string {
    const seconds = Math.floor((Date.now() - new Date(arrivedAt).getTime()) / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Get timer color based on wait time
   */
  getTimerColor(arrivedAt: string): 'green' | 'yellow' | 'red' {
    const minutes = Math.floor((Date.now() - new Date(arrivedAt).getTime()) / 60000);
    if (minutes < 3) return 'green';
    if (minutes < 5) return 'yellow';
    return 'red';
  }

  /**
   * Subscribe to real-time lane updates
   */
  subscribeToLaneUpdates(callback: (lane: DriveThruLane) => void): void {
    if (this.lanesChannel) {
      unsubscribeFromChannel(this.lanesChannel);
    }

    this.lanesChannel = subscribeToTable(
      'drive_thru_lanes',
      (payload: any) => {
        if (payload.new) {
          callback(transformLaneFromAPI(payload.new));
        }
      },
      `branch_id=eq.${this.branchId}`
    );
  }

  /**
   * Subscribe to real-time order updates
   */
  subscribeToOrderUpdates(callback: (order: DriveThruOrder) => void): void {
    if (this.ordersChannel) {
      unsubscribeFromChannel(this.ordersChannel);
    }

    this.ordersChannel = subscribeToTable(
      'drive_thru_orders',
      (payload: any) => {
        if (payload.new) {
          callback(transformOrderFromAPI(payload.new));
        }
      },
      `branch_id=eq.${this.branchId}`
    );
  }

  /**
   * Unsubscribe from all real-time updates
   */
  unsubscribeFromUpdates(): void {
    if (this.lanesChannel) {
      unsubscribeFromChannel(this.lanesChannel);
      this.lanesChannel = null;
    }
    if (this.ordersChannel) {
      unsubscribeFromChannel(this.ordersChannel);
      this.ordersChannel = null;
    }
  }
}

// Export singleton instance
export const driveThruService = new DriveThruService();
