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
import { useI18n } from '../../contexts/i18n-context';
import type { RestaurantTable, TableStatus } from '../../types/tables';
import { Users, LayoutGrid, Search } from 'lucide-react';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { formatTableDisplayNumber } from '../../utils/table-display';

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
 * Resolve a table's floor as a stable string key (mirrors the TablesDashboard pattern):
 * table.floorLevel ?? floor_level ?? 1, so every table maps to a floor segment.
 */
export function getTableFloorValue(table: RestaurantTable): string {
  const raw = table.floorLevel ?? (table as { floor_level?: number | null }).floor_level ?? 1;
  return raw === null || raw === undefined ? '1' : String(raw);
}

/**
 * Normalize a search token: lowercase and strip punctuation/separators while PRESERVING Unicode letters
 * and numbers (\p{L}/\p{N} with the u flag), so punctuation/case never breaks matching AND non-Latin
 * notes/terms survive in this multi-language app. "#TP03"/"TP03"/"tp03" collapse to "tp03", and
 * Greek/accented/non-Latin note text is kept intact rather than stripped to nothing.
 */
export function normalizeTableSearch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Search matching for the table picker: an operator searches what they SEE on the card, so a term
 * matches the raw tableNumber, the formatted display label (formatTableDisplayNumber, e.g. "#TP03"),
 * OR the notes -- all normalized. So "TP03", "#TP03", "tp03", "03", and "3" all find table "TP03".
 * formatTableDisplayNumber is the existing shared display formatter (no TP-/Greek-specific assumptions).
 */
export function tableMatchesSearchTerm(table: RestaurantTable, rawTerm: string): boolean {
  const term = normalizeTableSearch(rawTerm);
  if (!term) return true;
  const haystacks = [
    normalizeTableSearch(String(table.tableNumber)),
    normalizeTableSearch(formatTableDisplayNumber(table.tableNumber)),
    table.notes ? normalizeTableSearch(table.notes) : '',
  ];
  return haystacks.some(value => value.includes(term));
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

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCapacity, setSelectedCapacity] = useState<number | 'all'>('all');
  const [selectedFloor, setSelectedFloor] = useState<string>('all');

  // Filter tables based on status (Requirements 3.5)
  const selectableTables = useMemo(() => {
    return filterSelectableTables(tables, filterStatuses);
  }, [tables, filterStatuses]);

  // Further filter by search and capacity
  const filteredTables = useMemo(() => {
    let result = selectableTables;

    // Filter by search term: match what the operator SEES on the card -- the raw table number, the
    // formatted display label (e.g. "#TP03"), or the notes -- so typing "TP03"/"#TP03"/"tp03"/"03"/"3"
    // all work, not just the raw number.
    if (searchTerm.trim()) {
      result = result.filter(table => tableMatchesSearchTerm(table, searchTerm));
    }

    // Filter by capacity
    if (selectedCapacity !== 'all') {
      result = result.filter(table => table.capacity >= selectedCapacity);
    }

    // Filter by floor
    if (selectedFloor !== 'all') {
      result = result.filter(table => getTableFloorValue(table) === selectedFloor);
    }

    // Sort by table number
    return result.sort((a, b) => a.tableNumber - b.tableNumber);
  }, [selectableTables, searchTerm, selectedCapacity, selectedFloor]);

  // Get unique capacities for filter
  const capacityOptions = useMemo(() => {
    const capacities = [...new Set(selectableTables.map(t => t.capacity))].sort((a, b) => a - b);
    return capacities;
  }, [selectableTables]);

  // Unique sorted floors for the floor filter (mirrors TablesDashboard's floor segmentation)
  const floorOptions = useMemo(() => {
    const values = Array.from(new Set(selectableTables.map(table => getTableFloorValue(table))));
    return values.sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }, [selectableTables]);

  // Status configuration
  const statusConfig: Record<TableStatus, { label: string; bgClass: string; textClass: string }> = {
    available: {
      label: t('tableSelector.status.available', { defaultValue: 'Available' }),
      bgClass: 'border-green-500/50 bg-green-500/10',
      textClass: 'text-green-500'
    },
    reserved: {
      label: t('tableSelector.status.reserved', { defaultValue: 'Reserved' }),
      bgClass: 'border-yellow-500/50 bg-yellow-500/10',
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
    },
    maintenance: {
      label: t('tableSelector.status.maintenance', { defaultValue: 'Maintenance' }),
      bgClass: 'border-orange-500 bg-orange-500/10',
      textClass: 'text-orange-500'
    },
    unavailable: {
      label: t('tableSelector.status.unavailable', { defaultValue: 'Unavailable' }),
      bgClass: 'border-slate-500 bg-slate-500/10',
      textClass: 'text-slate-500'
    }
  };

  const handleTableClick = (table: RestaurantTable) => {
    onTableSelect(table);
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('tableSelector.title', { defaultValue: 'Select a Table' })}
      size="lg"
      /* Round 332 (live QA, 1282x802): bound THIS modal to the VISIBLE viewport so its bottom never clips
         and the last row of table cards stays reachable. The shared shell's base max-height:92vh resolves
         against a layout viewport taller than the visible WebView area, pushing the content's scroll bottom
         off-screen. A dvh cap (+ safe margin), flex column and overflow-hidden keep the shell on-screen; the
         content body below becomes the single hidden-scroll region with bottom + scroll padding so the final
         row clears the rounded bottom. Scoped to this modal via className/contentClassName -- no global
         change to LiquidGlassModal. */
      className="flex flex-col overflow-hidden !max-h-[calc(100dvh-2rem)]"
      contentClassName="flex-1 min-h-0 overflow-y-auto scrollbar-hide pb-6 scroll-pb-6"
    >
      {/* Glass surface (LiquidGlassModal) keeps TableSelector consistent with the Settings + Order Type
          modals: translucent blurred shell, soft amber edge/glow, rounded edges, open/close animation,
          and hidden scrollbars on the scrolling content. The inner controls reuse the same glass tokens
          plus restrained green (available) / amber (reserved) semantic accents. */}
      <div data-table-selector className="space-y-4">
        {/* Available count */}
        <p className="text-sm liquid-glass-modal-text-muted">
          {t('tableSelector.subtitle', {
            defaultValue: '{{count}} tables available',
            count: filteredTables.length,
          })}
        </p>

        {/* Filters: a FULL-WIDTH glass search row (language-safe -- the EN/EL/DE/FR/IT placeholders never
            clip, no locale-specific widths) with the floor + min-capacity segmented controls stacked
            below, each on its own row so long localized labels never squeeze the search field. */}
        <div data-table-selector-filters className="space-y-3">
          {/* Search -- own full-width row */}
          <div className="relative w-full">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 liquid-glass-modal-text-muted" />
            <input
              type="text"
              placeholder={t('tableSelector.searchPlaceholder', { defaultValue: 'Search by table number...' })}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              aria-label={t('tableSelector.searchPlaceholder', { defaultValue: 'Search by table number...' })}
              className="liquid-glass-modal-input w-full !pl-10"
            />
          </div>

          {/* Floor (segmented) -- shown whenever the selectable tables span any floor data */}
          {floorOptions.length > 0 && (
            <div data-table-selector-floor className="flex flex-wrap items-center gap-2">
              <span className="text-sm liquid-glass-modal-text-muted">
                {t('tableSelector.floor', { defaultValue: 'Floor' })}
              </span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedFloor('all')}
                  aria-pressed={selectedFloor === 'all'}
                  className={`inline-flex min-h-[40px] items-center justify-center rounded-full border px-3.5 text-sm font-medium transition active:scale-95 ${
                    selectedFloor === 'all'
                      ? 'border-amber-400/50 bg-amber-400/20 text-amber-900 dark:text-amber-100'
                      : 'liquid-glass-modal-border bg-white/5 liquid-glass-modal-text dark:bg-black/20'
                  }`}
                >
                  {t('tableSelector.allFloors', { defaultValue: 'All floors' })}
                </button>
                {floorOptions.map((floor) => (
                  <button
                    key={floor}
                    type="button"
                    onClick={() => setSelectedFloor(floor)}
                    aria-pressed={selectedFloor === floor}
                    className={`inline-flex min-h-[40px] items-center justify-center rounded-full border px-3.5 text-sm font-medium transition active:scale-95 ${
                      selectedFloor === floor
                        ? 'border-amber-400/50 bg-amber-400/20 text-amber-900 dark:text-amber-100'
                        : 'liquid-glass-modal-border bg-white/5 liquid-glass-modal-text dark:bg-black/20'
                    }`}
                  >
                    {t('tableSelector.floorNumber', { defaultValue: 'Floor {{floor}}', floor })}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Min capacity (segmented) -- own row */}
          <div data-table-selector-capacity className="flex flex-wrap items-center gap-2">
            <span className="text-sm liquid-glass-modal-text-muted">
              {t('tableSelector.minCapacity', { defaultValue: 'Min. capacity:' })}
            </span>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedCapacity('all')}
                aria-pressed={selectedCapacity === 'all'}
                className={`inline-flex min-h-[40px] items-center justify-center rounded-full border px-3.5 text-sm font-medium transition active:scale-95 ${
                  selectedCapacity === 'all'
                    ? 'border-amber-400/50 bg-amber-400/20 text-amber-900 dark:text-amber-100'
                    : 'liquid-glass-modal-border bg-white/5 liquid-glass-modal-text dark:bg-black/20'
                }`}
              >
                {t('tableSelector.all', { defaultValue: 'All' })}
              </button>
              {capacityOptions.map((capacity) => (
                <button
                  key={capacity}
                  type="button"
                  onClick={() => setSelectedCapacity(capacity)}
                  aria-pressed={selectedCapacity === capacity}
                  className={`inline-flex min-h-[40px] items-center justify-center rounded-full border px-3.5 text-sm font-medium transition active:scale-95 ${
                    selectedCapacity === capacity
                      ? 'border-amber-400/50 bg-amber-400/20 text-amber-900 dark:text-amber-100'
                      : 'liquid-glass-modal-border bg-white/5 liquid-glass-modal-text dark:bg-black/20'
                  }`}
                >
                  {capacity}+
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Status legend: semantic green (available) / amber (reserved) */}
        <div className="flex flex-wrap gap-4">
          {filterStatuses.map((status: TableStatus) => (
            <div key={status} className="flex items-center gap-2">
              <div
                className={`h-3 w-3 rounded-full ${status === 'available' ? 'bg-green-500' : 'bg-yellow-500'}`}
              />
              <span className="text-xs liquid-glass-modal-text-muted">{statusConfig[status].label}</span>
            </div>
          ))}
        </div>

        {/* Tables grid */}
        <div data-table-selector-grid className="min-h-[280px]">
          {filteredTables.length === 0 ? (
            <div className="flex min-h-[280px] items-center justify-center liquid-glass-modal-text-muted">
              <div className="text-center">
                <LayoutGrid className="mx-auto mb-4 h-16 w-16 opacity-50" />
                <p className="text-lg font-medium liquid-glass-modal-text">
                  {t('tableSelector.noTables', { defaultValue: 'No tables available' })}
                </p>
                <p className="mt-1 text-sm opacity-75">
                  {searchTerm || selectedCapacity !== 'all'
                    ? t('tableSelector.tryDifferentFilters', { defaultValue: 'Try different filters' })
                    : t('tableSelector.allTablesOccupied', { defaultValue: 'All tables are currently occupied or being cleaned' })}
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {filteredTables.map((table) => (
                <button
                  key={table.id}
                  type="button"
                  onClick={() => handleTableClick(table)}
                  className={`aspect-square rounded-2xl border p-3 backdrop-blur-md transition active:scale-95 ${statusConfig[table.status].bgClass}`}
                >
                  <div className="flex h-full flex-col items-center justify-center text-center">
                    <LayoutGrid className={`mb-1 h-6 w-6 ${statusConfig[table.status].textClass}`} />
                    <div className="text-lg font-bold liquid-glass-modal-text">
                      {formatTableDisplayNumber(table.tableNumber)}
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-xs liquid-glass-modal-text-muted">
                      <Users className="h-3 w-3" />
                      <span>{table.capacity}</span>
                    </div>
                    <div className={`mt-1 text-[10px] ${statusConfig[table.status].textClass}`}>
                      {statusConfig[table.status].label}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </LiquidGlassModal>
  );
});

TableSelector.displayName = 'TableSelector';

export default TableSelector;
