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
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { useTheme } from '../contexts/theme-context';
import { useTables } from '../hooks/useTables';
import { useTerminalSettings } from '../hooks/useTerminalSettings';
import { useFeatures } from '../hooks/useFeatures';
import { TableActionModal } from '../components/tables/TableActionModal';
import { TableCheckManagerModal } from '../components/tables/TableCheckManagerModal';
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
import { getBridge } from '../../lib';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';
import { formatTableSeats } from '../utils/i18nLabels';

// ============================================================
// CONSTANTS
// ============================================================

const AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

const STATUS_COLORS: Record<TableStatus, string> = {
  available: '#22c55e',
  occupied: '#27272a', // near-black: table in use (was brand blue)
  reserved: '#f59e0b',
  cleaning: '#a1a1aa',
  maintenance: '#d97706',
  unavailable: '#71717a',
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

// Resolve a table's floor as a stable string key, mirroring the TableSelector / TablesDashboard
// convention (table.floorLevel ?? floor_level ?? 1) so floor filtering stays consistent across surfaces.
const getTableFloorValue = (table: RestaurantTable): string => {
  const raw = table.floorLevel ?? (table as { floor_level?: number | null }).floor_level ?? 1;
  return raw === null || raw === undefined ? '1' : String(raw);
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
    <motion.button
      variants={pageMotionItem}
      onClick={onPress}
      className={`relative p-0 overflow-hidden rounded-xl border-2 transition-all duration-200 active:scale-[0.98] ${
        isSelected
          ? 'border-yellow-400 ring-2 ring-yellow-400/40'
          : isDark
          ? 'border-white/10'
          : 'border-gray-200'
      } ${isDark ? 'bg-white/[0.05]' : 'bg-white'}`}
    >
      {/* Status Bar */}
      <div className="h-1" style={{ backgroundColor: statusColor }} />

      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div
            className="w-10 h-10 rounded-2xl flex items-center justify-center text-lg font-bold"
            style={{ backgroundColor: `${statusColor}20`, color: statusColor }}
          >
            {table.tableNumber}
          </div>
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-2xl text-xs font-medium"
            style={{ backgroundColor: `${statusColor}20`, color: statusColor }}
          >
            <StatusIcon className="w-3 h-3" />
            <span>{t(`tables.status.${table.status}`, STATUS_LABELS[table.status])}</span>
          </div>
        </div>

        {/* Info — calm two-line metadata stack (Round 208): seats on the first line, the structured
            section on the second so it reads cleanly and wraps gracefully (no 60px truncation). */}
        <div className="space-y-1.5">
          <div className={`flex items-center gap-1.5 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <Users className="w-3.5 h-3.5 shrink-0" />
            <span>{formatTableSeats(t, table.capacity)}</span>
          </div>
          {table.section && (
            <div className={`flex items-start gap-1 text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              <MapPin className="w-3 h-3 shrink-0 mt-0.5" />
              <span className="min-w-0 break-words leading-snug">{table.section}</span>
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
    </motion.button>
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
    <motion.button
      variants={pageMotionItem}
      className={`absolute flex flex-col items-center justify-center shadow-lg transition-all duration-200 active:scale-95 ${
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
    </motion.button>
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
        isDark ? 'bg-black/80 backdrop-blur-xl border-white/10' : 'bg-white border-gray-200'
      }`}
    >
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('tables.filters.title', 'Filter Tables')}
          </h3>
          <button
            onClick={onClose}
            className={`p-1 rounded-2xl ${isDark ? 'active:bg-white/10' : 'active:bg-gray-100'}`}
            aria-label={t('common.actions.close', 'Close')}
          >
            <X className={`w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
          </button>
        </div>

        <div className="space-y-2">
          <p className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('tables.filters.status', 'Filter by Status')}
          </p>
          <div className="flex flex-wrap gap-2">
            {(['all', 'available', 'occupied', 'reserved', 'cleaning'] as const).map(status => (
              <button
                key={status}
                onClick={() => handleStatusChange(status)}
                className={`px-3 py-1.5 rounded-2xl text-xs font-medium transition-colors ${
                  filter.statusFilter === status
                    ? status === 'all'
                      ? 'bg-yellow-400 text-black'
                      : `text-white`
                    : isDark
                    ? 'bg-white/10 text-gray-300 active:bg-white/20'
                    : 'bg-gray-100 text-gray-600 active:bg-gray-200'
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
            className={`px-4 py-2 rounded-2xl text-sm font-medium ${
              isDark ? 'bg-white/10 text-gray-300 active:bg-white/20' : 'bg-gray-100 text-gray-600 active:bg-gray-200'
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
  canCreateOrders: boolean;
  featuresLoading: boolean;
  orderCreationDisabledMessage: string;
}

const StatusChangeModal = memo<StatusChangeModalProps>(({
  table,
  isOpen,
  onClose,
  onStatusChange,
  onNewOrder,
  onNewReservation,
  isDark,
  canCreateOrders,
  featuresLoading,
  orderCreationDisabledMessage,
}) => {
  const { t } = useTranslation();

  if (!isOpen || !table) return null;

  const statusActions: { status: TableStatus; label: string; icon: typeof CheckCircle; color: string }[] = [
    {
      status: 'available',
      label: table.status === 'cleaning'
        ? t('tables.actions.markCleaned', 'Cleaned')
        : table.status === 'maintenance'
          ? t('tables.actions.markBackInService', 'Back in service')
          : t('tables.actions.markAvailable', 'Set Available'),
      icon: CheckCircle,
      color: STATUS_COLORS.available,
    },
    { status: 'occupied', label: t('tables.actions.markOccupied', 'Set Occupied'), icon: Users, color: STATUS_COLORS.occupied },
    { status: 'reserved', label: t('tables.actions.markReserved', 'Set Reserved'), icon: Clock, color: STATUS_COLORS.reserved },
    { status: 'cleaning', label: t('tables.actions.markCleaning', 'Set Cleaning'), icon: Sparkles, color: STATUS_COLORS.cleaning },
    { status: 'maintenance', label: t('tables.actions.markMaintenance', 'Set Maintenance'), icon: AlertTriangle, color: STATUS_COLORS.maintenance },
  ];

  const handleStatusClick = (status: TableStatus) => {
    if (status !== table.status) {
      onStatusChange(table.id, status);
    }
    onClose();
  };
  const isNewOrderActionDisabled = !table.currentOrderId && !featuresLoading && !canCreateOrders;

  const modalContent = (
    // z-[1200] = POS app-modal layer: above the sidebar (z-50), FAB (z-[900]) and
    // content, below the custom titlebar. Combined with the portal below so the
    // backdrop/blur covers the full app shell, not just the table page/grid container.
    <div className="fixed inset-0 z-[1200] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div
        className={`relative w-full max-w-md mx-4 rounded-2xl border backdrop-blur-2xl ring-1 ${
          isDark
            ? 'bg-black/60 border-white/10 ring-white/15 shadow-2xl shadow-black/50'
            : 'bg-white/50 border-white/70 ring-white/60 shadow-2xl shadow-black/30'
        }`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <div>
            <h2 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('tables.tableNumber', 'Table {{number}}', { number: table.tableNumber })}
            </h2>
            <div
              className="inline-flex items-center gap-1.5 mt-1 px-2 py-1 rounded-2xl text-xs font-medium"
              style={{ backgroundColor: `${STATUS_COLORS[table.status]}20`, color: STATUS_COLORS[table.status] }}
            >
              {React.createElement(getStatusIcon(table.status), { className: 'w-3 h-3' })}
              <span>{t(`tables.status.${table.status}`, STATUS_LABELS[table.status])}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className={`p-2 rounded-2xl ${isDark ? 'active:bg-white/10 text-gray-400' : 'active:bg-gray-100 text-gray-500'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Table Info */}
        <div className={`px-4 py-3 flex items-center gap-4 border-b ${isDark ? 'border-white/10' : 'border-gray-100'}`}>
          <div className={`flex items-center gap-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
            <Users className="w-4 h-4" />
            <span className="text-sm">{formatTableSeats(t, table.capacity)}</span>
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
              {t('tables.actions.quickActions', 'Quick Actions')}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => onNewOrder(table)}
                disabled={isNewOrderActionDisabled}
                aria-disabled={isNewOrderActionDisabled}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium border transition-colors ${
                  isNewOrderActionDisabled
                    ? isDark
                      ? 'cursor-not-allowed bg-white/5 border-white/10 text-white/40'
                      : 'cursor-not-allowed bg-gray-100 border-gray-200 text-gray-400'
                    : isDark
                      ? 'bg-yellow-400/15 border-yellow-400/40 text-yellow-300 active:bg-yellow-400/25'
                      : '!bg-yellow-400 border-yellow-500 text-black active:!bg-yellow-500 shadow-lg shadow-yellow-500/30'
                }`}
              >
                <Receipt className="w-4 h-4" />
                <span>{table.currentOrderId ? t('tables.actions.viewOrder', 'View Order') : t('tables.actions.newOrder', 'New Order')}</span>
              </button>
              {table.status === 'available' && (
                <button
                  onClick={() => onNewReservation(table)}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium transition-colors ${
                    isDark
                      ? 'bg-white/10 text-white active:bg-white/20'
                      : 'bg-gray-100 text-gray-700 active:bg-gray-200'
                  }`}
                >
                  <Clock className="w-4 h-4" />
                  <span>{t('tables.actions.newReservation', 'Reserve')}</span>
                </button>
              )}
            </div>
            {isNewOrderActionDisabled && (
              <p className={`text-xs ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                {orderCreationDisabledMessage}
              </p>
            )}
          </div>
        )}

        {/* Status Actions */}
        <div className={`p-4 ${table.status === 'available' || table.status === 'occupied' ? 'border-t ' + (isDark ? 'border-white/10' : 'border-gray-100') : ''}`}>
          <p className={`text-xs font-medium mb-3 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('tables.actions.changeStatus', 'Change Status')}
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
                      : 'active:scale-[0.99]'
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

  // Render at the app-shell level so the backdrop/blur covers the full POS viewport
  // (sidebar + outer shell) instead of being clipped by the table page/grid container.
  if (typeof document === 'undefined' || !document.body) {
    return modalContent;
  }

  return createPortal(modalContent, document.body);
});

StatusChangeModal.displayName = 'StatusChangeModal';

// ============================================================
// MAIN COMPONENT
// ============================================================

const TablesPage: React.FC = () => {
  const bridge = getBridge();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { getSetting } = useTerminalSettings();
  const { isFeatureEnabled, loading: featuresLoading } = useFeatures();
  const canCreateOrders = isFeatureEnabled('orderCreation');
  const isDark = resolvedTheme === 'dark';
  const orderCreationDisabledMessage = t(
    'settings.terminal.messages.orderCreationDisabled',
    'Order creation is disabled for this terminal',
  );

  // Get terminal context
  const [branchId, setBranchId] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);

  // Resolve IDs from terminal config bridge
  useEffect(() => {
    bridge.terminalConfig
      .getBranchId()
      .then((bid: string | null) => setBranchId(bid ?? null))
      .catch(() => setBranchId(null));

    bridge.terminalConfig
      .getOrganizationId()
      .then((oid: string | null) => setOrganizationId(oid ?? null))
      .catch(() => setOrganizationId(null));
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
  const [showCheckManager, setShowCheckManager] = useState(false);
  const [checkManagerTable, setCheckManagerTable] = useState<RestaurantTable | null>(null);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [floorFilter, setFloorFilter] = useState<string>('all');

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
        t.tableNumber.toString().toLowerCase().includes(term) ||
        t.section?.toLowerCase().includes(term)
      );
    }

    // Filter by floor (composes with status + search)
    if (floorFilter !== 'all') {
      result = result.filter(t => getTableFloorValue(t) === floorFilter);
    }

    return result;
  }, [tables, filter, searchTerm, floorFilter]);

  // Unique floors derived from real table metadata; numeric floors sort numerically, strings lexically.
  const floorOptions = useMemo(() => {
    const values = Array.from(new Set(tables.map(getTableFloorValue)));
    return values.sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }, [tables]);

  const stats = useMemo(() => calculateTableStats(tables), [tables]);

  // Check for active filters
  const hasActiveFilters = filter.statusFilter !== 'all' || searchTerm !== '' || floorFilter !== 'all';

  // Handlers
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refetch();
    setIsRefreshing(false);
    toast.success(t('tables.messages.refreshed', 'Tables refreshed'));
  }, [refetch, t]);

  const handleTablePress = useCallback((table: RestaurantTable) => {
    setSelectedTable(table);
    setShowStatusModal(true);
  }, []);

  const handleStatusChange = useCallback(async (tableId: string, status: TableStatus) => {
    const success = await updateTableStatus(tableId, status);
    if (success) {
      toast.success(t('tables.messages.statusUpdated', 'Table status updated to {{status}}', {
        status: t(`tables.status.${status}`, STATUS_LABELS[status]),
      }));
    } else {
      toast.error(t('tables.messages.statusUpdateFailed', 'Failed to update table status'));
    }
  }, [updateTableStatus, t]);

  const handleNewOrder = useCallback((table: RestaurantTable) => {
    // Occupied table with an existing order ("View Order"): open the existing
    // table check/order flow (current items + total) instead of the blank
    // new-order screen. NewOrderPage only ever creates a fresh order.
    if (table.currentOrderId) {
      setShowStatusModal(false);
      setCheckManagerTable(table);
      setShowCheckManager(true);
      return;
    }
    if (!featuresLoading && !canCreateOrders) {
      // Terminal gate: once features have loaded, don't navigate to the (guarded)
      // NewOrderPage when creation is disabled; keep the user on the table grid/modal
      // and explain in the active language.
      toast.error(orderCreationDisabledMessage);
      return;
    }
    setShowStatusModal(false);
    const params = new URLSearchParams({
      orderType: 'dine-in',
      tableNumber: String(table.tableNumber),
      tableId: table.id,
    });
    navigate(`/new-order?${params.toString()}`);
  }, [canCreateOrders, featuresLoading, navigate, orderCreationDisabledMessage]);

  const handleCheckAddItems = useCallback((table: RestaurantTable) => {
    // Adding items continues into the dine-in order menu for this table.
    setShowCheckManager(false);
    setCheckManagerTable(null);
    const params = new URLSearchParams({
      orderType: 'dine-in',
      tableNumber: String(table.tableNumber),
      tableId: table.id,
    });
    navigate(`/new-order?${params.toString()}`);
  }, [navigate]);

  const handleCheckManagerClose = useCallback(() => {
    // Closing the check leaves the user on the table grid (not an empty embedded
    // orders view); refresh so any settlement/status change is reflected.
    setShowCheckManager(false);
    setCheckManagerTable(null);
    void refetch();
  }, [refetch]);

  const handleNewReservation = useCallback((table: RestaurantTable) => {
    setShowStatusModal(false);
    // Navigate to reservations with table pre-selected
    navigate(`/reservations?tableId=${table.id}&tableNumber=${table.tableNumber}`);
  }, [navigate]);

  const handleClearFilters = useCallback(() => {
    setFilter({ statusFilter: 'all' });
    setSearchTerm('');
    setFloorFilter('all');
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
      <div className={`h-full flex items-center justify-center ${isDark ? 'bg-black' : 'bg-[#fdfaf5]'}`}>
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-yellow-400 border-t-transparent rounded-full mx-auto mb-4" />
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('tables.messages.loading', 'Loading tables...')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={pageMotionContainer}
      className={`h-full flex flex-col ${isDark ? 'bg-black' : 'bg-[#fdfaf5]'}`}
    >
      {/* Header */}
      <motion.div variants={pageMotionItem} className="px-6 py-4 flex items-center justify-between">
        <div className="min-w-0">
          <h1 className={`truncate text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('tables.title', 'Tables')}
          </h1>
          <div className="mt-1 flex items-center gap-2">
            <p className={`truncate text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('tables.stats.availableTotal', '{{available}} available / {{total}} total', {
                available: stats.availableTables,
                total: stats.totalTables,
              })}
            </p>
            {/* Real-time indicator */}
            <Wifi className="h-3 w-3 shrink-0 text-green-500" />
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
              placeholder={t('tables.filters.search', 'Search tables...')}
              className={`w-48 pl-9 pr-4 py-2 rounded-xl text-sm bg-transparent outline-none ${
                isDark ? 'text-white placeholder:text-gray-500' : 'text-gray-900 placeholder:text-gray-400'
              }`}
            />
          </div>

          {/* View Mode Toggle */}
          <button
            onClick={() => setViewMode(viewMode === 'grid' ? 'floorplan' : 'grid')}
            aria-label={
              viewMode === 'grid'
                ? t('tables.layout.switchToFloorPlan', 'Switch to floor plan view')
                : t('tables.layout.switchToGrid', 'Switch to grid view')
            }
            className={`p-2.5 rounded-xl ${isDark ? 'bg-white/10 active:bg-white/20' : 'bg-white active:bg-gray-50'} border ${
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
              aria-label={t('tables.filters.title', 'Filter Tables')}
              className={`p-2.5 rounded-xl ${
                hasActiveFilters ? 'bg-yellow-400 text-black' : isDark ? 'bg-white/10 active:bg-white/20' : 'bg-white active:bg-gray-50'
              } border ${hasActiveFilters ? 'border-yellow-500' : isDark ? 'border-white/10' : 'border-gray-200'} transition-colors`}
            >
              <Filter className={`w-5 h-5 ${hasActiveFilters ? 'text-black' : isDark ? 'text-gray-300' : 'text-gray-600'}`} />
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
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            aria-label={t('common.refresh', 'Refresh')}
            className={`h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all shadow-sm ${
              isDark
                ? 'border border-white/80 bg-white text-black active:bg-zinc-200'
                : 'border border-black bg-black text-white active:bg-zinc-800'
            } ${isRefreshing ? 'opacity-60 cursor-not-allowed' : 'active:scale-95'}`}
          >
            <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </motion.div>

      {/* Stats Row */}
      <motion.div variants={pageMotionItem} className="px-6 pb-4">
        <motion.div variants={pageMotionContainer} className="flex gap-3 overflow-x-auto scrollbar-hide">
          {([
            { key: 'available', color: STATUS_COLORS.available, icon: CheckCircle, count: stats.availableTables },
            { key: 'occupied', color: STATUS_COLORS.occupied, icon: Users, count: stats.occupiedTables },
            { key: 'reserved', color: STATUS_COLORS.reserved, icon: Clock, count: stats.reservedTables },
            { key: 'cleaning', color: STATUS_COLORS.cleaning, icon: Coffee, count: stats.cleaningTables },
          ] as const).map(({ key, color, icon: Icon, count }) => (
            <motion.button
              key={key}
              variants={pageMotionItem}
              onClick={() => setFilter(f => ({ ...f, statusFilter: f.statusFilter === key ? 'all' : key }))}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border-2 transition-all ${
                filter.statusFilter === key
                  ? 'border-current'
                  : isDark
                  ? 'border-white/10 bg-white/5 active:bg-white/10'
                  : 'border-gray-200 bg-white active:bg-gray-50'
              }`}
              style={filter.statusFilter === key ? { borderColor: color } : undefined}
            >
              <div className="w-8 h-8 rounded-2xl flex items-center justify-center" style={{ backgroundColor: `${color}20` }}>
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
            </motion.button>
          ))}
        </motion.div>
      </motion.div>

      {/* Floor selector strip - direct, touch-first floor filtering under the stats row and above the
          grid (not hidden in the filter popover). Yellow = selected, neutral glass = rest; no hover. */}
      {floorOptions.length > 0 && (
        <motion.div variants={pageMotionItem} data-tables-floor-selector className="px-6 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              {t('tableSelector.floor', { defaultValue: 'Floor' })}
            </span>
            <button
              type="button"
              onClick={() => setFloorFilter('all')}
              aria-pressed={floorFilter === 'all'}
              className={`inline-flex min-h-[44px] items-center justify-center rounded-xl border px-4 text-sm font-medium transition active:scale-95 ${
                floorFilter === 'all'
                  ? 'border-yellow-500 bg-yellow-400 text-black'
                  : isDark
                    ? 'border-white/10 bg-white/5 text-gray-200 active:bg-white/10'
                    : 'border-gray-200 bg-white text-gray-700 active:bg-gray-50'
              }`}
            >
              {t('tableSelector.allFloors', { defaultValue: 'All floors' })}
            </button>
            {floorOptions.map((floor) => (
              <button
                key={floor}
                type="button"
                onClick={() => setFloorFilter(floor)}
                aria-pressed={floorFilter === floor}
                className={`inline-flex min-h-[44px] items-center justify-center rounded-xl border px-4 text-sm font-medium transition active:scale-95 ${
                  floorFilter === floor
                    ? 'border-yellow-500 bg-yellow-400 text-black'
                    : isDark
                      ? 'border-white/10 bg-white/5 text-gray-200 active:bg-white/10'
                      : 'border-gray-200 bg-white text-gray-700 active:bg-gray-50'
                }`}
              >
                {t('tableSelector.floorNumber', { defaultValue: 'Floor {{floor}}', floor })}
              </button>
            ))}
          </div>
        </motion.div>
      )}

      {/* Error Banner */}
      {error && (
        <motion.div variants={pageMotionItem} className="mx-6 mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <p className="text-red-500 text-sm">{error.message}</p>
        </motion.div>
      )}

      {/* Content */}
      <motion.div variants={pageMotionItem} className="flex-1 min-h-0 overflow-auto px-6 pb-6 scrollbar-hide">
        {viewMode === 'grid' ? (
          <motion.div variants={pageMotionContainer} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {filteredTables.map(table => (
              <TableCard
                key={table.id}
                table={table}
                isSelected={selectedTable?.id === table.id}
                onPress={() => handleTablePress(table)}
                isDark={isDark}
              />
            ))}
          </motion.div>
        ) : (
          <motion.div variants={pageMotionItem} className={`h-full min-h-[360px] rounded-2xl border ${isDark ? 'bg-white/[0.05] backdrop-blur-xl border-white/10' : 'bg-white border-gray-200'}`}>
            <div className={`floor-plan-scrollbar ${isDark ? 'floor-plan-scrollbar-dark' : 'floor-plan-scrollbar-light'} relative h-full min-h-[360px] w-full overflow-auto rounded-2xl`}>
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
                    {t('tables.messages.noTablesOnFloorPlan', 'No tables to display')}
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
          </motion.div>
        )}

        {/* Empty State */}
        {filteredTables.length === 0 && !isLoading && (
          <motion.div variants={pageMotionItem} className="flex flex-col items-center justify-center py-16">
            <Utensils className={`w-16 h-16 mb-4 ${isDark ? 'text-gray-600' : 'text-gray-300'}`} />
            <p className={`text-lg font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {hasActiveFilters
                ? t('tables.messages.noMatchingTables', 'No tables match your filters')
                : t('tables.messages.noTables', 'No tables found')}
            </p>
            {hasActiveFilters && (
              <button
                onClick={handleClearFilters}
                className="mt-4 px-4 py-2 rounded-xl border border-yellow-500 text-yellow-600 font-medium active:bg-yellow-500/10 transition-colors"
              >
                {t('tables.filters.clear', 'Clear Filters')}
              </button>
            )}
          </motion.div>
        )}
      </motion.div>

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
        canCreateOrders={canCreateOrders}
        featuresLoading={featuresLoading}
        orderCreationDisabledMessage={orderCreationDisabledMessage}
      />

      {/* Existing table order / check flow (View Order on an occupied table).
          Renders through LiquidGlassModal: app-level portal + blurred backdrop. */}
      <TableCheckManagerModal
        isOpen={showCheckManager}
        table={checkManagerTable}
        tables={tables}
        onAddItems={handleCheckAddItems}
        onRefreshTables={refetch}
        onRefreshOrders={refetch}
        onClose={handleCheckManagerClose}
      />
    </motion.div>
  );
};

export default TablesPage;
