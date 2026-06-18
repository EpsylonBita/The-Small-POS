// Table types for POS System
// Shared between components for table management

// Import canonical TableStatus from shared types
import type { TableStatus as CanonicalTableStatus } from '../../repo-shared/types/table-status';

// Re-export canonical TableStatus
export type TableStatus = CanonicalTableStatus;
export type TableShape = 'rectangle' | 'circle' | 'square' | 'custom' | 'round' | 'oval' | 'booth';

export interface RestaurantTable {
  id: string;
  organizationId: string;
  branchId: string;
  tableNumber: number;
  capacity: number;
  floorLevel?: number | null;
  floorPlanId?: string | null;
  section?: string | null;
  status: TableStatus;
  positionX: number | null;
  positionY: number | null;
  width?: number | null;
  height?: number | null;
  rotation?: number | null;
  shape: TableShape | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  // Optional fields for runtime state
  currentOrderId?: string;
  tableSessionId?: string | null;
  guestCount?: number | null;
  unpaidBalance?: number;
  balance?: {
    order_total?: number;
    paid_total?: number;
    tip_total?: number;
    outstanding_balance?: number;
    payment_status?: string | null;
  } | null;
  seatSummary?: Array<{
    seat_number: number | null;
    item_count: number;
    quantity: number;
  }>;
  serverId?: string;
  currentWaiterId?: string | null;
  currentWaiterName?: string | null;
  customerName?: string | null;
  occupiedSince?: string;
}

export interface TableFilters {
  statusFilter?: TableStatus | 'all';
  searchTerm?: string;
  capacityMin?: number;
  capacityMax?: number;
}

export interface TableStats {
  totalTables: number;
  availableTables: number;
  occupiedTables: number;
  reservedTables: number;
  cleaningTables: number;
  occupancyRate: number;
}

// Tab configuration for TablesDashboard
export type TablesDashboardTab = 'orders' | 'delivered' | 'canceled' | 'tables';

export interface TabConfig {
  id: TablesDashboardTab;
  label: string;
  count: number;
  color: string;
}

// Database response type (snake_case)
export interface TableAPIResponse {
  id: string;
  organization_id: string;
  branch_id: string;
  table_number: number;
  capacity: number;
  floor_level?: number | null;
  floor_plan_id?: string | null;
  section?: string | null;
  status: TableStatus;
  position_x: number | null;
  position_y: number | null;
  width?: number | null;
  height?: number | null;
  rotation?: number | null;
  shape: TableShape | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  current_order_id?: string | null;
  table_session_id?: string | null;
  guest_count?: number | null;
  current_waiter_id?: string | null;
  current_waiter_name?: string | null;
  customer_name?: string | null;
  occupied_since?: string | null;
  unpaid_balance?: number | null;
  balance?: RestaurantTable['balance'];
  seat_summary?: RestaurantTable['seatSummary'];
}

// Transformation functions
export function transformTableFromAPI(apiTable: TableAPIResponse): RestaurantTable {
  return {
    id: apiTable.id,
    organizationId: apiTable.organization_id,
    branchId: apiTable.branch_id,
    tableNumber: apiTable.table_number,
    capacity: apiTable.capacity,
    floorLevel: apiTable.floor_level ?? null,
    floorPlanId: apiTable.floor_plan_id ?? null,
    section: apiTable.section ?? null,
    status: apiTable.status,
    positionX: apiTable.position_x,
    positionY: apiTable.position_y,
    width: apiTable.width ?? null,
    height: apiTable.height ?? null,
    rotation: apiTable.rotation ?? null,
    shape: apiTable.shape,
    notes: apiTable.notes,
    createdAt: apiTable.created_at,
    updatedAt: apiTable.updated_at,
    currentOrderId: apiTable.current_order_id || undefined,
    tableSessionId: apiTable.table_session_id || null,
    guestCount: apiTable.guest_count ?? null,
    currentWaiterId: apiTable.current_waiter_id || null,
    currentWaiterName: apiTable.current_waiter_name || null,
    customerName: apiTable.customer_name || null,
    occupiedSince: apiTable.occupied_since || undefined,
    unpaidBalance: Number(apiTable.unpaid_balance || apiTable.balance?.outstanding_balance || 0),
    balance: apiTable.balance || null,
    seatSummary: apiTable.seat_summary || [],
  };
}

// Utility functions
export function getStatusColor(status: TableStatus): string {
  switch (status) {
    case 'available':
      return 'green';
    case 'occupied':
      return 'blue';
    case 'reserved':
      return 'yellow';
    case 'cleaning':
      return 'gray';
    case 'maintenance':
      return 'orange';
    case 'unavailable':
      return 'slate';
    default:
      return 'gray';
  }
}

export function getStatusClasses(status: TableStatus): string {
  const colors: Record<TableStatus, string> = {
    available: 'border-green-500 bg-green-500/10',
    occupied: 'border-blue-500 bg-blue-500/10',
    reserved: 'border-yellow-500 bg-yellow-500/10',
    cleaning: 'border-gray-500 bg-gray-500/10',
    maintenance: 'border-orange-500 bg-orange-500/10',
    unavailable: 'border-slate-500 bg-slate-500/10',
  };
  return colors[status] || colors.available;
}
