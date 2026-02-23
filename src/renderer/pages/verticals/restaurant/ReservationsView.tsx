/**
 * ReservationsView - POS Reservations Management
 * 
 * Real-time reservation management for restaurant POS.
 * Supports Tables and Rooms tabs with list and timeline views.
 */

import React, { memo, useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useAcquiredModules } from '../../../hooks/useAcquiredModules';
import { useReservations } from '../../../hooks/useReservations';
import { formatDate, formatTime } from '../../../utils/format';
import {
  Calendar,
  Users,
  Phone,
  Clock,
  Search,
  ChevronLeft,
  ChevronRight,
  List,
  LayoutGrid,
  RefreshCw,
  AlertTriangle,
  UtensilsCrossed,
  BedDouble,
} from 'lucide-react';
import type { Reservation, ReservationStatus, ReservationFilters } from '../../../services/ReservationsService';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../../services/terminal-credentials';
import { offEvent, onEvent } from '../../../../lib';

type QuickFilter = 'today' | 'tomorrow' | 'week';
type ViewMode = 'timeline' | 'list';
type ReservationTab = 'tables' | 'rooms';

// Status colors and labels
const statusColors: Record<ReservationStatus, string> = {
  confirmed: 'blue',
  pending: 'yellow',
  seated: 'green',
  completed: 'gray',
  no_show: 'red',
  cancelled: 'gray',
};

export const ReservationsView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId } = useModules();
  const { hasTablesModule, hasRoomsModule } = useAcquiredModules();
  
  // Get branchId from terminal credential cache / IPC
  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);
  
  useEffect(() => {
    let disposed = false;

    const hydrateTerminalIdentity = async () => {
      const cached = getCachedTerminalCredentials();
      if (!disposed) {
        setBranchId(cached.branchId || null);
        setLocalOrgId(cached.organizationId || null);
      }

      const refreshed = await refreshTerminalCredentialCache();
      if (!disposed) {
        setBranchId(refreshed.branchId || null);
        setLocalOrgId(refreshed.organizationId || null);
      }
    };

    const handleConfigUpdate = (data: { branch_id?: string; organization_id?: string }) => {
      if (disposed) return;
      if (typeof data?.branch_id === 'string' && data.branch_id.trim()) {
        setBranchId(data.branch_id.trim());
      }
      if (typeof data?.organization_id === 'string' && data.organization_id.trim()) {
        setLocalOrgId(data.organization_id.trim());
      }
    };

    hydrateTerminalIdentity();
    onEvent('terminal-config-updated', handleConfigUpdate);

    return () => {
      disposed = true;
      offEvent('terminal-config-updated', handleConfigUpdate);
    };
  }, []);

  // Use module context organizationId if available, otherwise fall back to localStorage
  const effectiveOrgId = organizationId || localOrgId;
  
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('today');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [activeTab, setActiveTab] = useState<ReservationTab>(() => {
    // Default to tables if available, otherwise rooms
    return 'tables';
  });

  const isDark = resolvedTheme === 'dark';

  // Auto-select tab based on available modules
  useEffect(() => {
    if (!hasTablesModule && hasRoomsModule) {
      setActiveTab('rooms');
    } else if (hasTablesModule && !hasRoomsModule) {
      setActiveTab('tables');
    }
  }, [hasTablesModule, hasRoomsModule]);

  // Build filters based on selected date and quick filter
  const filters: ReservationFilters = useMemo(() => {
    const baseFilters: ReservationFilters = {};
    
    if (quickFilter === 'week') {
      const weekStart = new Date(selectedDate);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      baseFilters.dateFrom = weekStart.toISOString().split('T')[0];
      baseFilters.dateTo = weekEnd.toISOString().split('T')[0];
    } else {
      const dateStr = selectedDate.toISOString().split('T')[0];
      baseFilters.dateFrom = dateStr;
      baseFilters.dateTo = dateStr;
    }

    if (searchTerm) {
      baseFilters.searchTerm = searchTerm;
    }

    return baseFilters;
  }, [selectedDate, quickFilter, searchTerm]);

  // Use reservations hook
  const {
    reservations,
    isLoading,
    refetch,
    updateStatus,
  } = useReservations({
    branchId: branchId || '',
    organizationId: effectiveOrgId || '',
    filters,
    enableRealtime: true,
  });

  // Filter reservations based on active tab
  // Tables tab shows reservations with table_id, Rooms tab shows reservations with room_id
  const filteredReservations = useMemo(() => {
    if (activeTab === 'tables') {
      return reservations.filter(r => r.tableId);
    } else {
      // Room reservations have room_id set
      return reservations.filter(r => r.roomId);
    }
  }, [reservations, activeTab]);

  // Calculate stats for filtered reservations
  const filteredStats = useMemo(() => {
    const filtered = filteredReservations;
    return {
      total: filtered.length,
      pending: filtered.filter(r => r.status === 'pending').length,
      confirmed: filtered.filter(r => r.status === 'confirmed').length,
      seated: filtered.filter(r => r.status === 'seated').length,
      totalGuests: filtered.reduce((sum, r) => sum + r.partySize, 0),
    };
  }, [filteredReservations]);

  const statusLabels: Record<ReservationStatus, string> = {
    confirmed: t('reservationsView.status.confirmed', { defaultValue: 'Confirmed' }),
    pending: t('reservationsView.status.pending', { defaultValue: 'Pending' }),
    seated: t('reservationsView.status.seated', { defaultValue: 'Seated' }),
    completed: t('reservationsView.status.completed', { defaultValue: 'Completed' }),
    no_show: t('reservationsView.status.no_show', { defaultValue: 'No Show' }),
    cancelled: t('reservationsView.status.cancelled', { defaultValue: 'Cancelled' }),
  };

  const handleQuickFilter = useCallback((filter: QuickFilter) => {
    setQuickFilter(filter);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (filter === 'today') {
      setSelectedDate(today);
    } else if (filter === 'tomorrow') {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      setSelectedDate(tomorrow);
    }
  }, []);

  const navigateDate = useCallback((direction: 'prev' | 'next') => {
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() + (direction === 'next' ? 1 : -1));
    setSelectedDate(newDate);
    setQuickFilter('today');
  }, [selectedDate]);

  const handleStatusChange = useCallback(async (reservationId: string, status: ReservationStatus) => {
    await updateStatus(reservationId, status);
  }, [updateStatus]);

  // Time slots for timeline view (11 AM to 10 PM)
  const timeSlots = Array.from({ length: 12 }, (_, i) => 11 + i);

  // Group filtered reservations by hour for timeline view
  const reservationsByHour = useMemo(() => {
    const grouped: Record<number, Reservation[]> = {};
    timeSlots.forEach(hour => { grouped[hour] = []; });
    
    filteredReservations.forEach(res => {
      const hour = new Date(res.reservationDatetime).getHours();
      if (grouped[hour]) {
        grouped[hour].push(res);
      }
    });
    
    return grouped;
  }, [filteredReservations, timeSlots]);

  // Get quick actions for a reservation
  const getQuickActions = (reservation: Reservation) => {
    const actions: { label: string; status: ReservationStatus; variant: string }[] = [];

    if (reservation.status === 'pending') {
      actions.push({ label: t('reservationsView.actions.confirm', { defaultValue: 'Confirm' }), status: 'confirmed', variant: 'primary' });
    }
    if (reservation.status === 'confirmed') {
      actions.push({ label: t('reservationsView.actions.seat', { defaultValue: 'Seat' }), status: 'seated', variant: 'success' });
    }
    if (reservation.status === 'seated') {
      actions.push({ label: t('reservationsView.actions.complete', { defaultValue: 'Complete' }), status: 'completed', variant: 'primary' });
    }
    if (['pending', 'confirmed'].includes(reservation.status)) {
      actions.push({ label: t('reservationsView.actions.noShow', { defaultValue: 'No Show' }), status: 'no_show', variant: 'danger' });
    }

    return actions;
  };

  if (!branchId || !effectiveOrgId) {
    return (
      <div className={`h-full flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        {t('reservationsView.noBranch', { defaultValue: 'Please select a branch to view reservations' })}
      </div>
    );
  }

  // Show message if neither module is acquired
  if (!hasTablesModule && !hasRoomsModule) {
    return (
      <div className={`h-full flex flex-col items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        <Calendar className="w-16 h-16 mb-4 opacity-50" />
        <p className="text-lg font-medium mb-2">
          {t('reservationsView.noModules', { defaultValue: 'No reservation modules available' })}
        </p>
        <p className="text-sm text-center max-w-md">
          {t('reservationsView.noModulesHint', { defaultValue: 'Please acquire the Tables or Rooms module to manage reservations.' })}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4">
      {/* Tabs - only show if both modules are available */}
      {hasTablesModule && hasRoomsModule && (
        <div className={`flex gap-1 mb-4 p-1 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
          <button
            onClick={() => setActiveTab('tables')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'tables'
                ? 'bg-blue-600 text-white shadow-lg'
                : isDark
                  ? 'text-gray-400 hover:text-white hover:bg-gray-700'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-white'
            }`}
          >
            <UtensilsCrossed className="w-5 h-5" />
            {t('reservationsView.tabs.tables', { defaultValue: 'Tables' })}
            <span className={`ml-1 px-2 py-0.5 rounded-full text-xs ${
              activeTab === 'tables' ? 'bg-white/20' : isDark ? 'bg-gray-700' : 'bg-gray-200'
            }`}>
              {reservations.filter(r => r.tableId).length}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('rooms')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'rooms'
                ? 'bg-purple-600 text-white shadow-lg'
                : isDark
                  ? 'text-gray-400 hover:text-white hover:bg-gray-700'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-white'
            }`}
          >
            <BedDouble className="w-5 h-5" />
            {t('reservationsView.tabs.rooms', { defaultValue: 'Rooms' })}
            <span className={`ml-1 px-2 py-0.5 rounded-full text-xs ${
              activeTab === 'rooms' ? 'bg-white/20' : isDark ? 'bg-gray-700' : 'bg-gray-200'
            }`}>
              {reservations.filter(r => r.roomId).length}
            </span>
          </button>
        </div>
      )}

      {/* Single module header - show which type of reservations we're viewing */}
      {(hasTablesModule !== hasRoomsModule) && (
        <div className={`flex items-center gap-2 mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {hasTablesModule ? (
            <>
              <UtensilsCrossed className="w-6 h-6 text-blue-500" />
              <h2 className="text-xl font-semibold">{t('reservationsView.tabs.tables', { defaultValue: 'Table Reservations' })}</h2>
            </>
          ) : (
            <>
              <BedDouble className="w-6 h-6 text-purple-500" />
              <h2 className="text-xl font-semibold">{t('reservationsView.tabs.rooms', { defaultValue: 'Room Reservations' })}</h2>
            </>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-4">
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('reservationsView.stats.total', { defaultValue: 'Total' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{filteredStats.total}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm text-yellow-500`}>
              {t('reservationsView.stats.pending', { defaultValue: 'Pending' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{filteredStats.pending}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm text-blue-500`}>
              {t('reservationsView.stats.confirmed', { defaultValue: 'Confirmed' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{filteredStats.confirmed}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm text-green-500`}>
              {t('reservationsView.stats.seated', { defaultValue: 'Seated' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{filteredStats.seated}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm text-purple-500`}>
              {t('reservationsView.stats.guests', { defaultValue: 'Guests' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{filteredStats.totalGuests}</div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}
            title={t('reservationsView.refresh', { defaultValue: 'Refresh' })}
          >
            <RefreshCw className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <div className="relative">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('reservationsView.searchPlaceholder', { defaultValue: 'Search...' })}
              className={`pl-10 pr-4 py-2 rounded-lg ${isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
            />
          </div>
        </div>
      </div>

      {/* Filters Row */}
      <div className="flex items-center justify-between mb-4">
        {/* Quick Filters */}
        <div className="flex gap-2">
          {(['today', 'tomorrow', 'week'] as QuickFilter[]).map(filter => (
            <button
              key={filter}
              onClick={() => handleQuickFilter(filter)}
              className={`px-3 py-1.5 rounded-lg text-sm ${
                quickFilter === filter
                  ? 'bg-blue-600 text-white'
                  : isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {t(`reservationsView.filter.${filter}`, { defaultValue: filter.charAt(0).toUpperCase() + filter.slice(1) })}
            </button>
          ))}
        </div>

        {/* Date Navigation */}
        <div className="flex items-center gap-2">
          <button onClick={() => navigateDate('prev')} className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}>
            <ChevronLeft className="w-5 h-5" />
          </button>
          <input
            type="date"
            value={selectedDate.toISOString().split('T')[0]}
            onChange={(e) => setSelectedDate(new Date(e.target.value))}
            className={`px-3 py-2 rounded-lg ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
          />
          <button onClick={() => navigateDate('next')} className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}>
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* View Toggle */}
        <div className={`flex rounded-lg overflow-hidden ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
          <button
            onClick={() => setViewMode('list')}
            className={`px-3 py-2 flex items-center gap-1 ${viewMode === 'list' ? 'bg-blue-600 text-white' : isDark ? 'text-gray-300' : 'text-gray-600'}`}
          >
            <List className="w-4 h-4" />
            {t('reservationsView.view.list', { defaultValue: 'List' })}
          </button>
          <button
            onClick={() => setViewMode('timeline')}
            className={`px-3 py-2 flex items-center gap-1 ${viewMode === 'timeline' ? 'bg-blue-600 text-white' : isDark ? 'text-gray-300' : 'text-gray-600'}`}
          >
            <LayoutGrid className="w-4 h-4" />
            {t('reservationsView.view.timeline', { defaultValue: 'Timeline' })}
          </button>
        </div>
      </div>

      {/* Pending Alert */}
      {filteredStats.pending > 0 && (
        <div className={`mb-4 p-3 rounded-lg flex items-center gap-2 ${isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'}`}>
          <AlertTriangle className="w-5 h-5 text-yellow-500" />
          <span className="text-yellow-600 font-medium">
            {filteredStats.pending} {t('reservationsView.pendingAlert', { defaultValue: 'reservation(s) pending confirmation' })}
          </span>
        </div>
      )}

      {/* Loading State */}
      {isLoading && reservations.length === 0 && (
        <div className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          {t('reservationsView.loading', { defaultValue: 'Loading reservations...' })}
        </div>
      )}

      {/* Content */}
      {!isLoading && (
        <div className="flex-1 overflow-y-auto">
          {viewMode === 'list' ? (
            /* List View */
            <div className="space-y-2">
              {filteredReservations.map(res => (
                <div
                  key={res.id}
                  className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}
                  style={{ borderLeft: `4px solid var(--${statusColors[res.status]}-500, #6b7280)` }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <span className={`font-medium text-lg ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {res.customerName}
                        </span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium bg-${statusColors[res.status]}-500/10 text-${statusColors[res.status]}-500`}>
                          {statusLabels[res.status]}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="flex items-center gap-1">
                          <Clock className="w-4 h-4" />
                          {formatTime(res.reservationDatetime, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Users className="w-4 h-4" />
                          {res.partySize} {t('reservationsView.guests', { defaultValue: 'guests' })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Phone className="w-4 h-4" />
                          {res.customerPhone}
                        </span>
                        {res.tableId && (
                          <span className="flex items-center gap-1">
                            <Calendar className="w-4 h-4" />
                            {t('reservationsView.table', { defaultValue: 'Table' })} #{res.tableNumber || res.tableId.slice(-4)}
                          </span>
                        )}
                        {res.roomId && (
                          <span className="flex items-center gap-1">
                            <BedDouble className="w-4 h-4" />
                            {t('reservationsView.room', { defaultValue: 'Room' })} {res.roomNumber || res.roomId.slice(-4)}
                          </span>
                        )}
                        {res.checkInDate && res.checkOutDate && (
                          <span className="flex items-center gap-1">
                            <Calendar className="w-4 h-4" />
                            {formatDate(res.checkInDate)} - {formatDate(res.checkOutDate)}
                          </span>
                        )}
                      </div>
                      {res.specialRequests && (
                        <div className={`mt-2 text-sm ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>
                          <AlertTriangle className="w-3 h-3 inline mr-1" />
                          {res.specialRequests}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {getQuickActions(res).map(action => (
                        <button
                          key={action.status}
                          onClick={() => handleStatusChange(res.id, action.status)}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                            action.variant === 'primary' ? 'bg-blue-600 text-white hover:bg-blue-700' :
                            action.variant === 'success' ? 'bg-green-600 text-white hover:bg-green-700' :
                            action.variant === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' :
                            isDark ? 'bg-gray-700 text-white' : 'bg-gray-200 text-gray-800'
                          }`}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Timeline View */
            <div className="grid grid-cols-[60px_1fr] gap-2">
              {timeSlots.map(hour => {
                const hourReservations = reservationsByHour[hour] || [];
                return (
                  <React.Fragment key={hour}>
                    <div className={`text-sm font-medium py-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      {hour}:00
                    </div>
                    <div className={`min-h-[60px] p-2 rounded-lg ${isDark ? 'bg-gray-800/50' : 'bg-gray-50'}`}>
                      <div className="flex flex-wrap gap-2">
                        {hourReservations.map(res => (
                          <div
                            key={res.id}
                            className={`px-3 py-2 rounded-lg ${isDark ? 'bg-gray-700' : 'bg-white shadow-sm'}`}
                            style={{ borderLeft: `4px solid var(--${statusColors[res.status]}-500, #6b7280)` }}
                          >
                            <div className="flex items-center gap-2">
                              <span className={`font-medium text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
                                {res.customerName}
                              </span>
                              <span className={`text-xs px-2 py-0.5 rounded bg-${statusColors[res.status]}-500/10 text-${statusColors[res.status]}-500`}>
                                {statusLabels[res.status]}
                              </span>
                            </div>
                            <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                              {res.tableId 
                                ? `${t('reservationsView.table', { defaultValue: 'Table' })} #${res.tableNumber || res.tableId.slice(-4)}` 
                                : res.roomId 
                                  ? `${t('reservationsView.room', { defaultValue: 'Room' })} ${res.roomNumber || res.roomId.slice(-4)}`
                                  : t('reservationsView.noTable', { defaultValue: 'No table' })
                              } • {res.partySize} {t('reservationsView.guests', { defaultValue: 'guests' })}
                            </div>
                            <div className="flex gap-1 mt-2">
                              {getQuickActions(res).slice(0, 2).map(action => (
                                <button
                                  key={action.status}
                                  onClick={() => handleStatusChange(res.id, action.status)}
                                  className={`px-2 py-1 rounded text-xs font-medium ${
                                    action.variant === 'primary' ? 'bg-blue-600 text-white' :
                                    action.variant === 'success' ? 'bg-green-600 text-white' :
                                    action.variant === 'danger' ? 'bg-red-600 text-white' :
                                    isDark ? 'bg-gray-600 text-white' : 'bg-gray-200 text-gray-800'
                                  }`}
                                >
                                  {action.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          )}

          {filteredReservations.length === 0 && !isLoading && (
            <div className={`text-center py-12 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">
                {t('reservationsView.noReservations', { defaultValue: 'No reservations found' })}
              </p>
              <p className="text-sm">
                {t('reservationsView.noReservationsHint', { defaultValue: 'Try selecting a different date or adjusting your search' })}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

ReservationsView.displayName = 'ReservationsView';
export default ReservationsView;
