/**
 * TablesPage - Restaurant table management for Desktop POS
 *
 * Features:
 * - Grid and floor plan visualization
 * - Real-time table status updates via Supabase
 * - Status management (available → occupied → reserved → cleaning)
 * - Table filtering by status, section, floor
 * - Quick actions for orders and reservations
 * - Offline queue support
 *
 * @since 2.3.0
 */

import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { useTheme } from '../contexts/theme-context';
import { useTables } from '../hooks/useTables';
import { useTerminalSettings } from '../hooks/useTerminalSettings';
import { TableActionModal } from '../components/tables/TableActionModal';
import type { RestaurantTable, TableStatus, TableFilters, TableStats } from '../types/tables';
import { getStatusClasses } from '../types/tables';
import {
  Utensils,
  Users,
  Clock,
  RefreshCw,
  CheckCircle,
  XCircle,
  Coffee,
  Ban,
  Filter,
  Grid3X3,
  LayoutGrid,
  Wifi,
  WifiOff,
  MapPin,
  X,
  AlertTriangle,
  Sparkles,
  Receipt,
  UserPlus,
  Search,
  ChevronDown,
} from 'lucide-react';

// ============================================================
// CONSTANTS
// ============================================================

const AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

const STATUS_COLORS: Record<TableStatus, string> = {
  available: '#22c55e',
  occupied: '#3b82f6',
  reserved: '#f59e0b',
  cleaning: '#6b7280',
  maintenance: '#f97316',
  unavailable: '#64748b',
};

const STATUS_LABELS: Record<TableStatus, string> = {
  available: 'Available',
  occupied: 'Occupied',
  reserved: 'Reserved',
  cleaning: 'Cleaning',
  maintenance: 'Maintenance',
  unavailable: 'Unavailable',
};

type ViewMode = 'grid' | 'floorplan';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

const getStatusIcon = (status: TableStatus) => {
  switch (status) {
    case 'available':
      return CheckCircle;
    case 'occupied':
      return Users;
    case 'reserved':
      return Clock;
    case 'cleaning':
      return Coffee;
    default:
      return Utensils;
  }
};

const getElapsedTime = (since?: string): string => {
  if (!since) return '';
  const minutes = Math.floor((Date.now() - new Date(since).getTime()) / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return `${hours}h ${remainingMins}m`;
};

const calculateTableStats = (tables: RestaurantTable[]): TableStats => {
  const total = tables.length;
  const available = tables.filter(t => t.status === 'available').length;
  const occupied = tables.filter(t => t.status === 'occupied').length;
  const reserved = tables.filter(t => t.status === 'reserved').length;
  const cleaning = tables.filter(t => t.status === 'cleaning').length;

  return {
    totalTables: total,
    availableTables: available,
    occupiedTables: occupied,
    reservedTables: reserved,
    cleaningTables: cleaning,
    occupancyRate: total > 0 ? Math.round((occupied / total) * 100) : 0,
  };
};

// ============================================================
// TABLE CARD COMPONENT
// ============================================================

interface TableCardProps {
  table: RestaurantTable;
  isSelected: boolean;
  onPress: () => void;
  isDark: boolean;
}

const TableCard = memo<TableCardProps>(({ table, isSelected, onPress, isDark }) => {
  const { t } = useTranslation();
  const statusColor = STATUS_COLORS[table.status];
  const StatusIcon = getStatusIcon(table.status);

  return (
    <button
      onClick={onPress}
      className={`relative p-0 overflow-hidden rounded-xl border-2 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] ${
        isSelected
          ? 'border-blue-500 ring-2 ring-blue-500/30'
          : isDark
          ? 'border-white/10 hover:border-white/20'
          : 'border-gray-200 hover:border-gray-300'
      } ${isDark ? 'bg-gray-800/50' : 'bg-white'}`}
    >
      {/* Status Bar */}
      <div className="h-1" style={{ backgroundColor: statusColor }} />

      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center text-lg font-bold"
            style={{ backgroundColor: `${statusColor}20`, color: statusColor }}
          >
            {table.tableNumber}
          </div>
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium"
            style={{ backgroundColor: `${statusColor}20`, color: statusColor }}
          >
            <StatusIcon className="w-3 h-3" />
            <span>{t(`tables.status.${table.status}`, STATUS_LABELS[table.status])}</span>
          </div>
        </div>

        {/* Info */}
        <div className="flex items-center justify-between">
          <div className={`flex items-center gap-1.5 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <Users className="w-3.5 h-3.5" />
            <span>{table.capacity} {t('tables.seats', 'seats')}</span>
          </div>
          {table.notes && (
            <div className={`flex items-center gap-1 text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              <MapPin className="w-3 h-3" />
              <span className="truncate max-w-[60px]">{table.notes}</span>
            </div>
          )}
        </div>

        {/* Occupied Info */}
        {table.status === 'occupied' && table.occupiedSince && (
          <div className={`mt-3 pt-3 border-t ${isDark ? 'border-white/10' : 'border-gray-100'}`}>
            <div className={`flex items-center gap-1.5 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              <Clock className="w-3 h-3" />
              <span>{getElapsedTime(table.occupiedSince)}</span>
            </div>
          </div>
        )}
      </div>
    </button>
  );
});

TableCard.displayName = 'TableCard';

// ============================================================
// FLOOR PLAN TABLE COMPONENT
// ============================================================

interface FloorPlanTableProps {
  table: RestaurantTable;
  scale: number;
  isSelected: boolean;
  onPress: () => void;
  isDark: boolean;
}

const FloorPlanTable = memo<FloorPlanTableProps>(({ table, scale, isSelected, onPress, isDark }) => {
  const statusColor = STATUS_COLORS[table.status];
  const width = 80 * scale;
  const height = 80 * scale;
  const left = (table.positionX || 0) * scale;
  const top = (table.positionY || 0) * scale;

  const getBorderRadius = (shape: string | null) => {
    switch (shape) {
      case 'circle':
        return '50%';
      case 'square':
        return '8px';
      default:
        return '4px';
    }
  };

  return (
    <button
      className={`absolute flex flex-col items-center justify-center shadow-lg transition-all duration-200 hover:scale-105 ${
        isSelected ? 'ring-4 ring-white/50' : ''
      }`}
      style={{
        left,
        top,
        width,
        height,
        backgroundColor: statusColor,
        borderRadius: getBorderRadius(table.shape),
        border: isSelected ? '3px solid white' : '1px solid rgba(0,0,0,0.2)',
      }}
      onClick={onPress}
    >
      <span className="text-white font-bold text-sm drop-shadow">{table.tableNumber}</span>
      {table.status === 'occupied' && (
        <Users className="w-3 h-3 text-white/80 mt-0.5" />
      )}
    </button>
  );
});

FloorPlanTable.displayName = 'FloorPlanTable';

// ============================================================
// FILTER DROPDOWN
// ============================================================

interface FilterDropdownProps {
  filter: TableFilters;
  onFilterChange: (filter: TableFilters) => void;
  isDark: boolean;
  onClose: () => void;
}

const FilterDropdown = memo<FilterDropdownProps>(({ filter, onFilterChange, isDark, onClose }) => {
  const { t } = useTranslation();

  const handleStatusChange = (status: TableStatus | 'all') => {
    onFilterChange({ ...filter, statusFilter: status });
  };

  const handleReset = () => {
    onFilterChange({ statusFilter: 'all' });
    onClose();
  };

  return (
    <div
      className={`absolute top-full right-0 mt-2 w-64 rounded-xl shadow-2xl border z-50 ${
        isDark ? 'bg-gray-800 border-white/10' : 'bg-white border-gray-200'
      }`}
    >
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('tables.filterTables', 'Filter Tables')}
          </h3>
          <button onClick={onClose} className={`p-1 rounded-lg ${isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'}`}>
            <X className={`w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
          </button>
        </div>

        <div className="space-y-2">
          <p className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('tables.status', 'Status')}
          </p>
          <div className="flex flex-wrap gap-2">
            {(['all', 'available', 'occupied', 'reserved', 'cleaning'] as const).map(status => (
              <button
                key={status}
                onClick={() => handleStatusChange(status)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  filter.statusFilter === status
                    ? status === 'all'
                      ? 'bg-blue-500 text-white'
                      : `text-white`
                    : isDark
                    ? 'bg-white/10 text-gray-300 hover:bg-white/20'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                style={
                  filter.statusFilter === status && status !== 'all'
                    ? { backgroundColor: STATUS_COLORS[status] }
                    : undefined
                }
              >
                {status === 'all' ? t('common.all', 'All') : t(`tables.status.${status}`, STATUS_LABELS[status])}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-white/10 flex justify-end">
          <button
            onClick={handleReset}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${
              isDark ? 'bg-white/10 text-gray-300 hover:bg-white/20' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t('common.reset', 'Reset')}
          </button>
        </div>
      </div>
    </div>
  );
});

FilterDropdown.displayName = 'FilterDropdown';

// ============================================================
// STATUS CHANGE MODAL
// ============================================================

interface StatusChangeModalProps {
  table: RestaurantTable | null;
  isOpen: boolean;
  onClose: () => void;
  onStatusChange: (tableId: string, status: TableStatus) => void;
  onNewOrder: (table: RestaurantTable) => void;
  onNewReservation: (table: RestaurantTable) => void;
  isDark: boolean;
}

const StatusChangeModal = memo<StatusChangeModalProps>(({
  table,
  isOpen,
  onClose,
  onStatusChange,
  onNewOrder,
  onNewReservation,
  isDark,
}) => {
  const { t } = useTranslation();

  if (!isOpen || !table) return null;

  const statusActions: { status: TableStatus; label: string; icon: typeof CheckCircle; color: string }[] = [
    { status: 'available', label: t('tables.setAvailable', 'Set Available'), icon: CheckCircle, color: STATUS_COLORS.available },
    { status: 'occupied', label: t('tables.setOccupied', 'Set Occupied'), icon: Users, color: STATUS_COLORS.occupied },
    { status: 'reserved', label: t('tables.setReserved', 'Set Reserved'), icon: Clock, color: STATUS_COLORS.reserved },
    { status: 'cleaning', label: t('tables.setCleaning', 'Set Cleaning'), icon: Sparkles, color: STATUS_COLORS.cleaning },
  ];

  const handleStatusClick = (status: TableStatus) => {
    if (status !== table.status) {
      onStatusChange(table.id, status);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div
        className={`relative w-full max-w-md mx-4 rounded-2xl shadow-2xl ${
          isDark ? 'bg-gray-900 border border-white/10' : 'bg-white'
        }`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <div>
            <h2 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('tables.tableNumber', 'Table {{number}}', { number: table.tableNumber })}
            </h2>
            <div
              className="inline-flex items-center gap-1.5 mt-1 px-2 py-1 rounded-lg text-xs font-medium"
              style={{ backgroundColor: `${STATUS_COLORS[table.status]}20`, color: STATUS_COLORS[table.status] }}
            >
              {React.createElement(getStatusIcon(table.status), { className: 'w-3 h-3' })}
              <span>{t(`tables.status.${table.status}`, STATUS_LABELS[table.status])}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg ${isDark ? 'hover:bg-white/10 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Table Info */}
        <div className={`px-4 py-3 flex items-center gap-4 border-b ${isDark ? 'border-white/10' : 'border-gray-100'}`}>
          <div className={`flex items-center gap-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
            <Users className="w-4 h-4" />
            <span className="text-sm">{table.capacity} {t('tables.seats', 'seats')}</span>
          </div>
          {table.occupiedSince && table.status === 'occupied' && (
            <div className={`flex items-center gap-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              <Clock className="w-4 h-4" />
              <span className="text-sm">{getElapsedTime(table.occupiedSince)}</span>
            </div>
          )}
        </div>

        {/* Quick Actions */}
        {(table.status === 'available' || table.status === 'occupied') && (
          <div className="p-4 space-y-2">
            <p className={`text-xs font-medium mb-3 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('tables.quickActions', 'Quick Actions')}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => onNewOrder(table)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-blue-500 text-white font-medium hover:bg-blue-600 transition-colors"
              >
                <Receipt className="w-4 h-4" />
                <span>{table.currentOrderId ? t('tables.viewOrder', 'View Order') : t('tables.newOrder', 'New Order')}</span>
              </button>
              {table.status === 'available' && (
                <button
                  onClick={() => onNewReservation(table)}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium transition-colors ${
                    isDark
                      ? 'bg-white/10 text-white hover:bg-white/20'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  <Clock className="w-4 h-4" />
                  <span>{t('tables.newReservation', 'Reserve')}</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Status Actions */}
        <div className={`p-4 ${table.status === 'available' || table.status === 'occupied' ? 'border-t ' + (isDark ? 'border-white/10' : 'border-gray-100') : ''}`}>
          <p className={`text-xs font-medium mb-3 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('tables.changeStatus', 'Change Status')}
          </p>
          <div className="space-y-2">
            {statusActions.map(action => {
              const isCurrentStatus = table.status === action.status;
              return (
                <button
                  key={action.status}
                  onClick={() => handleStatusClick(action.status)}
                  disabled={isCurrentStatus}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${
                    isCurrentStatus
                      ? 'opacity-50 cursor-not-allowed'
                      : 'hover:scale-[1.01] active:scale-[0.99]'
                  } ${isDark ? 'border-white/10' : 'border-gray-200'}`}
                  style={{ borderColor: isCurrentStatus ? undefined : action.color }}
                >
                  <action.icon className="w-5 h-5" style={{ color: isCurrentStatus ? '#9ca3af' : action.color }} />
                  <span
                    className="font-medium"
                    style={{ color: isCurrentStatus ? '#9ca3af' : action.color }}
                  >
                    {action.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
});

StatusChangeModal.displayName = 'StatusChangeModal';

// ============================================================
// MAIN COMPONENT
// ============================================================

const TablesPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { getSetting } = useTerminalSettings();
  const isDark = resolvedTheme === 'dark';

  // Get terminal context
  const [branchId, setBranchId] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);

  // Resolve IDs from Electron
  useEffect(() => {
    const api = (window as any)?.electronAPI;
    if (api?.getTerminalBranchId) {
      api.getTerminalBranchId().then((bid: string | null) => setBranchId(bid));
    }
    if (api?.getTerminalOrganizationId) {
      api.getTerminalOrganizationId().then((oid: string | null) => setOrganizationId(oid));
    }
  }, []);

  // Use tables hook
  const { tables, isLoading, error, refetch, updateTableStatus } = useTables({
    branchId: branchId || '',
    organizationId: organizationId || '',
    enabled: !!(branchId && organizationId),
  });

  // Local state
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [filter, setFilter] = useState<TableFilters>({ statusFilter: 'all' });
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const [selectedTable, setSelectedTable] = useState<RestaurantTable | null>(null);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Derived data
  const filteredTables = useMemo(() => {
    let result = tables;

    // Filter by status
    if (filter.statusFilter && filter.statusFilter !== 'all') {
      result = result.filter(t => t.status === filter.statusFilter);
    }

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(t =>
        t.tableNumber.toString().includes(term) ||
        t.notes?.toLowerCase().includes(term)
      );
    }

    return result;
  }, [tables, filter, searchTerm]);

  const stats = useMemo(() => calculateTableStats(tables), [tables]);

  // Check for active filters
  const hasActiveFilters = filter.statusFilter !== 'all' || searchTerm !== '';

  // Handlers
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refetch();
    setIsRefreshing(false);
    toast.success(t('tables.refreshed', 'Tables refreshed'));
  }, [refetch, t]);

  const handleTablePress = useCallback((table: RestaurantTable) => {
    setSelectedTable(table);
    setShowStatusModal(true);
  }, []);

  const handleStatusChange = useCallback(async (tableId: string, status: TableStatus) => {
    const success = await updateTableStatus(tableId, status);
    if (success) {
      toast.success(t('tables.statusUpdated', 'Table status updated'));
    } else {
      toast.error(t('tables.statusUpdateFailed', 'Failed to update table status'));
    }
  }, [updateTableStatus, t]);

  const handleNewOrder = useCallback((table: RestaurantTable) => {
    setShowStatusModal(false);
    // Navigate to menu with table context
    navigate(`/menu?orderType=dine-in&tableNumber=${table.tableNumber}&tableId=${table.id}`);
  }, [navigate]);

  const handleNewReservation = useCallback((table: RestaurantTable) => {
    setShowStatusModal(false);
    // Navigate to reservations with table pre-selected
    navigate(`/reservations?tableId=${table.id}&tableNumber=${table.tableNumber}`);
  }, [navigate]);

  const handleClearFilters = useCallback(() => {
    setFilter({ statusFilter: 'all' });
    setSearchTerm('');
  }, []);

  // Floor plan scale calculation
  const floorPlanScale = useMemo(() => {
    if (filteredTables.length === 0) return 0.5;
    const maxX = Math.max(...filteredTables.map(t => (t.positionX || 0) + 80));
    const maxY = Math.max(...filteredTables.map(t => (t.positionY || 0) + 80));
    const containerWidth = 800;
    const containerHeight = 500;
    const scaleX = containerWidth / Math.max(maxX, 500);
    const scaleY = containerHeight / Math.max(maxY, 400);
    return Math.min(scaleX, scaleY, 1);
  }, [filteredTables]);

  // Loading state
  if (isLoading && tables.length === 0) {
    return (
      <div className={`h-full flex items-center justify-center ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('tables.loading', 'Loading tables...')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header */}
      <div className="px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-blue-500/20 flex items-center justify-center">
            <Utensils className="w-6 h-6 text-blue-500" />
          </div>
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('tables.title', 'Tables')}
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {stats.availableTables} {t('tables.available', 'available')} / {stats.totalTables} {t('tables.total', 'total')}
              </p>
              {/* Real-time indicator */}
              <Wifi className="w-3 h-3 text-green-500" />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className={`relative ${isDark ? 'bg-white/10' : 'bg-white'} rounded-xl border ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-400'}`} />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder={t('tables.search', 'Search tables...')}
              className={`w-48 pl-9 pr-4 py-2 rounded-xl text-sm bg-transparent outline-none ${
                isDark ? 'text-white placeholder:text-gray-500' : 'text-gray-900 placeholder:text-gray-400'
              }`}
            />
          </div>

          {/* View Mode Toggle */}
          <button
            onClick={() => setViewMode(viewMode === 'grid' ? 'floorplan' : 'grid')}
            className={`p-2.5 rounded-xl ${isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-white hover:bg-gray-50'} border ${
              isDark ? 'border-white/10' : 'border-gray-200'
            } transition-colors`}
          >
            {viewMode === 'grid' ? (
              <LayoutGrid className={`w-5 h-5 ${isDark ? 'text-gray-300' : 'text-gray-600'}`} />
            ) : (
              <Grid3X3 className={`w-5 h-5 ${isDark ? 'text-gray-300' : 'text-gray-600'}`} />
            )}
          </button>

          {/* Filter */}
          <div className="relative">
            <button
              onClick={() => setShowFilterDropdown(!showFilterDropdown)}
              className={`p-2.5 rounded-xl ${
                hasActiveFilters ? 'bg-blue-500 text-white' : isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-white hover:bg-gray-50'
              } border ${hasActiveFilters ? 'border-blue-500' : isDark ? 'border-white/10' : 'border-gray-200'} transition-colors`}
            >
              <Filter className={`w-5 h-5 ${hasActiveFilters ? 'text-white' : isDark ? 'text-gray-300' : 'text-gray-600'}`} />
            </button>
            {showFilterDropdown && (
              <FilterDropdown
                filter={filter}
                onFilterChange={setFilter}
                isDark={isDark}
                onClose={() => setShowFilterDropdown(false)}
              />
            )}
          </div>

          {/* Refresh */}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className={`p-2.5 rounded-xl ${isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-white hover:bg-gray-50'} border ${
              isDark ? 'border-white/10' : 'border-gray-200'
            } transition-colors disabled:opacity-50`}
          >
            <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''} ${isDark ? 'text-gray-300' : 'text-gray-600'}`} />
          </button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="px-6 pb-4">
        <div className="flex gap-3 overflow-x-auto scrollbar-hide">
          {([
            { key: 'available', color: STATUS_COLORS.available, icon: CheckCircle, count: stats.availableTables },
            { key: 'occupied', color: STATUS_COLORS.occupied, icon: Users, count: stats.occupiedTables },
            { key: 'reserved', color: STATUS_COLORS.reserved, icon: Clock, count: stats.reservedTables },
            { key: 'cleaning', color: STATUS_COLORS.cleaning, icon: Coffee, count: stats.cleaningTables },
          ] as const).map(({ key, color, icon: Icon, count }) => (
            <button
              key={key}
              onClick={() => setFilter(f => ({ ...f, statusFilter: f.statusFilter === key ? 'all' : key }))}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border-2 transition-all ${
                filter.statusFilter === key
                  ? 'border-current'
                  : isDark
                  ? 'border-white/10 bg-white/5 hover:bg-white/10'
                  : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}
              style={filter.statusFilter === key ? { borderColor: color } : undefined}
            >
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${color}20` }}>
                <Icon className="w-4 h-4" style={{ color }} />
              </div>
              <div className="text-left">
                <div className="text-lg font-bold" style={{ color }}>
                  {count}
                </div>
                <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t(`tables.status.${key}`, STATUS_LABELS[key as TableStatus])}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-6 mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <p className="text-red-500 text-sm">{error.message}</p>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {viewMode === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {filteredTables.map(table => (
              <TableCard
                key={table.id}
                table={table}
                isSelected={selectedTable?.id === table.id}
                onPress={() => handleTablePress(table)}
                isDark={isDark}
              />
            ))}
          </div>
        ) : (
          <div className={`rounded-2xl border ${isDark ? 'bg-gray-800/50 border-white/10' : 'bg-white border-gray-200'}`}>
            <div className="relative w-full h-[500px] overflow-hidden rounded-2xl">
              {filteredTables.map(table => (
                <FloorPlanTable
                  key={table.id}
                  table={table}
                  scale={floorPlanScale}
                  isSelected={selectedTable?.id === table.id}
                  onPress={() => handleTablePress(table)}
                  isDark={isDark}
                />
              ))}
              {filteredTables.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t('tables.noTablesOnFloorPlan', 'No tables to display')}
                  </p>
                </div>
              )}
            </div>

            {/* Legend */}
            <div className={`p-4 border-t ${isDark ? 'border-white/10' : 'border-gray-100'} flex flex-wrap gap-4 justify-center`}>
              {Object.entries(STATUS_COLORS).map(([status, color]) => (
                <div key={status} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                  <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t(`tables.status.${status}`, STATUS_LABELS[status as TableStatus])}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {filteredTables.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-16">
            <Utensils className={`w-16 h-16 mb-4 ${isDark ? 'text-gray-600' : 'text-gray-300'}`} />
            <p className={`text-lg font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {hasActiveFilters
                ? t('tables.noMatchingTables', 'No tables match your filters')
                : t('tables.noTables', 'No tables found')}
            </p>
            {hasActiveFilters && (
              <button
                onClick={handleClearFilters}
                className="mt-4 px-4 py-2 rounded-xl border border-blue-500 text-blue-500 font-medium hover:bg-blue-500/10 transition-colors"
              >
                {t('tables.clearFilters', 'Clear Filters')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Status Change Modal */}
      <StatusChangeModal
        table={selectedTable}
        isOpen={showStatusModal}
        onClose={() => {
          setShowStatusModal(false);
          setSelectedTable(null);
        }}
        onStatusChange={handleStatusChange}
        onNewOrder={handleNewOrder}
        onNewReservation={handleNewReservation}
        isDark={isDark}
      />
    </div>
  );
};

export default TablesPage;
