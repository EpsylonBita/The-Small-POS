// Table types for POS System
// Shared between components for table management

export type TableStatus = 'available' | 'occupied' | 'reserved' | 'cleaning';
export type TableShape = 'rectangle' | 'circle' | 'square' | 'custom';

export interface RestaurantTable {
  id: string;
  organizationId: string;
  branchId: string;
  tableNumber: number;
  capacity: number;
  status: TableStatus;
  positionX: number | null;
  positionY: number | null;
  shape: TableShape | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  // Optional fields for runtime state
  currentOrderId?: string;
  serverId?: string;
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
  status: TableStatus;
  position_x: number | null;
  position_y: number | null;
  shape: TableShape | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Transformation functions
export function transformTableFromAPI(apiTable: TableAPIResponse): RestaurantTable {
  return {
    id: apiTable.id,
    organizationId: apiTable.organization_id,
    branchId: apiTable.branch_id,
    tableNumber: apiTable.table_number,
    capacity: apiTable.capacity,
    status: apiTable.status,
    positionX: apiTable.position_x,
    positionY: apiTable.position_y,
    shape: apiTable.shape,
    notes: apiTable.notes,
    createdAt: apiTable.created_at,
    updatedAt: apiTable.updated_at,
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
    default:
      return 'gray';
  }
}

export function getStatusClasses(status: TableStatus): string {
  const colors = {
    available: 'border-green-500 bg-green-500/10',
    occupied: 'border-blue-500 bg-blue-500/10',
    reserved: 'border-yellow-500 bg-yellow-500/10',
    cleaning: 'border-gray-500 bg-gray-500/10',
  };
  return colors[status] || colors.available;
}
