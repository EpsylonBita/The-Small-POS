/**
 * TableSelector Component
 * 
 * Displays tables in grid format with capacity and status for selection.
 * Filters to show only available and reserved tables.
 * 
 * Requirements:
 * - 3.1: Display available tables with their capacity and current status
 * - 3.5: Filter to show only available and reserved tables (not occupied or cleaning)
 * 
 * **Feature: pos-tables-reservations-sync, Property 3: Table Selection Filtering**
 * **Validates: Requirements 3.5**
 */

import React, { memo, useMemo, useState } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import type { RestaurantTable, TableStatus } from '../../types/tables';
import { X, Users, LayoutGrid, Search } from 'lucide-react';

interface TableSelectorProps {
  tables: RestaurantTable[];
  onTableSelect: (table: RestaurantTable) => void;
  onClose: () => void;
  isOpen: boolean;
  /** Optional filter statuses - defaults to ['available', 'reserved'] per Requirements 3.5 */
  filterStatuses?: TableStatus[];
}

/**
 * Filter tables to show only selectable statuses
 * Requirements 3.5: Filter to show only available and reserved tables
 * 
 * @param tables - All tables
 * @param allowedStatuses - Statuses to include (defaults to available and reserved)
 * @returns Filtered tables
 */
export function filterSelectableTables(
  tables: RestaurantTable[],
  allowedStatuses: TableStatus[] = ['available', 'reserved']
): RestaurantTable[] {
  return tables.filter(table => allowedStatuses.includes(table.status));
}

/**
 * TableSelector - Grid display for selecting tables
 * 
 * Shows available and reserved tables for selection when creating
 * table orders or reservations.
 */
// Default filter statuses per Requirements 3.5
const DEFAULT_FILTER_STATUSES: TableStatus[] = ['available', 'reserved'];

export const TableSelector: React.FC<TableSelectorProps> = memo(({
  tables,
  onTableSelect,
  onClose,
  isOpen,
  filterStatuses = DEFAULT_FILTER_STATUSES
}) => {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCapacity, setSelectedCapacity] = useState<number | 'all'>('all');

  // Filter tables based on status (Requirements 3.5)
  const selectableTables = useMemo(() => {
    return filterSelectableTables(tables, filterStatuses);
  }, [tables, filterStatuses]);

  // Further filter by search and capacity
  const filteredTables = useMemo(() => {
    let result = selectableTables;

    // Filter by search term (table number)
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(table => 
        table.tableNumber.toString().includes(term) ||
        (table.notes && table.notes.toLowerCase().includes(term))
      );
    }

    // Filter by capacity
    if (selectedCapacity !== 'all') {
      result = result.filter(table => table.capacity >= selectedCapacity);
    }

    // Sort by table number
    return result.sort((a, b) => a.tableNumber - b.tableNumber);
  }, [selectableTables, searchTerm, selectedCapacity]);

  // Get unique capacities for filter
  const capacityOptions = useMemo(() => {
    const capacities = [...new Set(selectableTables.map(t => t.capacity))].sort((a, b) => a - b);
    return capacities;
  }, [selectableTables]);

  // Status configuration
  const statusConfig: Record<TableStatus, { label: string; bgClass: string; textClass: string }> = {
    available: {
      label: t('tableSelector.status.available', { defaultValue: 'Available' }),
      bgClass: 'border-green-500 bg-green-500/10 hover:bg-green-500/20',
      textClass: 'text-green-500'
    },
    reserved: {
      label: t('tableSelector.status.reserved', { defaultValue: 'Reserved' }),
      bgClass: 'border-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/20',
      textClass: 'text-yellow-500'
    },
    occupied: {
      label: t('tableSelector.status.occupied', { defaultValue: 'Occupied' }),
      bgClass: 'border-blue-500 bg-blue-500/10',
      textClass: 'text-blue-500'
    },
    cleaning: {
      label: t('tableSelector.status.cleaning', { defaultValue: 'Cleaning' }),
      bgClass: 'border-gray-500 bg-gray-500/10',
      textClass: 'text-gray-500'
    }
  };

  const handleTableClick = (table: RestaurantTable) => {
    onTableSelect(table);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className={`relative w-full max-w-4xl max-h-[90vh] mx-4 rounded-2xl shadow-2xl flex flex-col ${
        isDark ? 'bg-gray-900 border border-white/10' : 'bg-white'
      }`}>
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b shrink-0 ${
          isDark ? 'border-white/10' : 'border-gray-200'
        }`}>
          <div>
            <h2 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('tableSelector.title', { defaultValue: 'Select a Table' })}
            </h2>
            <p className={`text-sm mt-1 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
              {t('tableSelector.subtitle', { 
                defaultValue: '{{count}} tables available',
                count: filteredTables.length 
              })}
            </p>
          </div>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg transition-colors ${
              isDark 
                ? 'hover:bg-white/10 text-white/70 hover:text-white' 
                : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'
            }`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filters */}
        <div className={`p-4 border-b shrink-0 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <div className="flex flex-wrap gap-3">
            {/* Search */}
            <div className="relative flex-1 min-w-[200px]">
              <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${
                isDark ? 'text-white/40' : 'text-gray-400'
              }`} />
              <input
                type="text"
                placeholder={t('tableSelector.searchPlaceholder', { defaultValue: 'Search by table number...' })}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className={`w-full pl-10 pr-4 py-2 rounded-lg border transition-colors ${
                  isDark
                    ? 'bg-white/5 border-white/10 text-white placeholder-white/40 focus:border-blue-500'
                    : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-blue-500'
                } focus:outline-none focus:ring-2 focus:ring-blue-500/20`}
              />
            </div>

            {/* Capacity Filter */}
            <div className="flex items-center gap-2">
              <span className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                {t('tableSelector.minCapacity', { defaultValue: 'Min. capacity:' })}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setSelectedCapacity('all')}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    selectedCapacity === 'all'
                      ? 'bg-blue-600 text-white'
                      : isDark
                        ? 'bg-white/5 text-white/70 hover:bg-white/10'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {t('tableSelector.all', { defaultValue: 'All' })}
                </button>
                {capacityOptions.map(capacity => (
                  <button
                    key={capacity}
                    onClick={() => setSelectedCapacity(capacity)}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      selectedCapacity === capacity
                        ? 'bg-blue-600 text-white'
                        : isDark
                          ? 'bg-white/5 text-white/70 hover:bg-white/10'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {capacity}+
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Status Legend */}
          <div className="flex gap-4 mt-3">
            {filterStatuses.map((status: TableStatus) => (
              <div key={status} className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${
                  status === 'available' ? 'bg-green-500' : 'bg-yellow-500'
                }`} />
                <span className={`text-xs ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                  {statusConfig[status].label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Tables Grid */}
        <div className="flex-1 overflow-y-auto p-4">
          {filteredTables.length === 0 ? (
            <div className={`h-full flex items-center justify-center ${
              isDark ? 'text-white/50' : 'text-gray-500'
            }`}>
              <div className="text-center">
                <LayoutGrid className="w-16 h-16 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium">
                  {t('tableSelector.noTables', { defaultValue: 'No tables available' })}
                </p>
                <p className="text-sm mt-1 opacity-75">
                  {searchTerm || selectedCapacity !== 'all'
                    ? t('tableSelector.tryDifferentFilters', { defaultValue: 'Try different filters' })
                    : t('tableSelector.allTablesOccupied', { defaultValue: 'All tables are currently occupied or being cleaned' })
                  }
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
              {filteredTables.map(table => (
                <button
                  key={table.id}
                  onClick={() => handleTableClick(table)}
                  className={`aspect-square p-3 rounded-xl border-2 transition-all hover:scale-105 active:scale-95 ${
                    statusConfig[table.status].bgClass
                  }`}
                >
                  <div className="h-full flex flex-col items-center justify-center">
                    <LayoutGrid className={`w-6 h-6 mb-1 ${statusConfig[table.status].textClass}`} />
                    <div className={`font-bold text-lg ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      #{table.tableNumber}
                    </div>
                    <div className={`flex items-center gap-1 text-xs mt-1 ${
                      isDark ? 'text-white/60' : 'text-gray-500'
                    }`}>
                      <Users className="w-3 h-3" />
                      <span>{table.capacity}</span>
                    </div>
                    <div className={`text-[10px] mt-1 ${statusConfig[table.status].textClass}`}>
                      {statusConfig[table.status].label}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

TableSelector.displayName = 'TableSelector';

export default TableSelector;
