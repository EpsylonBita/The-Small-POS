import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
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
  
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

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
  const statusConfig: Record<TableStatus, { label: string; textClass: string }> = {
    available: {
      label: t('tableSelector.status.available', { defaultValue: 'Available' }),
      textClass: 'text-green-800 dark:text-green-400'
    },
    reserved: {
      label: t('tableSelector.status.reserved', { defaultValue: 'Reserved' }),
      textClass: 'text-yellow-700 dark:text-yellow-400'
    },
    occupied: {
      label: t('tableSelector.status.occupied', { defaultValue: 'Occupied' }),
      textClass: 'text-blue-500'
    },
    cleaning: {
      label: t('tableSelector.status.cleaning', { defaultValue: 'Cleaning' }),
      textClass: 'text-gray-500'
    },
    maintenance: {
      label: t('tableSelector.status.maintenance', { defaultValue: 'Maintenance' }),
      textClass: 'text-orange-700 dark:text-orange-400'
    },
    unavailable: {
      label: t('tableSelector.status.unavailable', { defaultValue: 'Unavailable' }),
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
      className="flex flex-col overflow-hidden max-h-[calc(100dvh-2rem)]! [&_.liquid-glass-modal-header]:border-b-0!"
      contentClassName="flex-1 min-h-0 overflow-y-auto scrollbar-hide pb-6 scroll-pb-6"
    >
      {/* Glass surface (LiquidGlassModal) keeps TableSelector consistent with the Settings + Order Type
          modals: translucent blurred shell, soft amber edge/glow, rounded edges, open/close animation,
          and hidden scrollbars on the scrolling content. The inner controls reuse the same glass tokens
          plus restrained green (available) / amber (reserved) semantic accents. */}
      <div data-table-selector className="space-y-3">
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
        <div data-table-selector-filters className="pos-glass-form-card space-y-3">
          {/* Search -- own full-width row */}
          <div className="relative w-full">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 liquid-glass-modal-text-muted" />
            <input
              type="text"
              placeholder={t('tableSelector.searchPlaceholder', { defaultValue: 'Search by table number...' })}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              aria-label={t('tableSelector.searchPlaceholder', { defaultValue: 'Search by table number...' })}
              className="liquid-glass-modal-input pos-glass-field min-h-touch w-full pl-10!"
            />
          </div>

          {/* Floor (segmented) -- shown whenever the selectable tables span any floor data */}
          <AnimatePresence initial={false}>{floorOptions.length > 0 && (
            <motion.div {...revealMotion} data-table-selector-floor className="flex flex-wrap items-center gap-2">
              <span className="text-sm liquid-glass-modal-text-muted">
                {t('tableSelector.floor', { defaultValue: 'Floor' })}
              </span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedFloor('all')}
                  aria-pressed={selectedFloor === 'all'}
                  className={`inline-flex min-h-touch items-center justify-center rounded-full border px-3.5 text-sm font-medium transition ${
                    selectedFloor === 'all'
                      ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg)'
                      : 'pos-glass-field'
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
                    className={`inline-flex min-h-touch items-center justify-center rounded-full border px-3.5 text-sm font-medium transition ${
                      selectedFloor === floor
                        ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg)'
                        : 'pos-glass-field'
                    }`}
                  >
                    {t('tableSelector.floorNumber', { defaultValue: 'Floor {{floor}}', floor })}
                  </button>
                ))}
              </div>
            </motion.div>
          )}</AnimatePresence>

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
                className={`inline-flex min-h-touch items-center justify-center rounded-full border px-3.5 text-sm font-medium transition ${
                  selectedCapacity === 'all'
                    ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg)'
                    : 'pos-glass-field'
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
                  className={`inline-flex min-h-touch items-center justify-center rounded-full border px-3.5 text-sm font-medium transition ${
                    selectedCapacity === capacity
                      ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg)'
                      : 'pos-glass-field'
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
          <AnimatePresence initial={false}>{filteredTables.length === 0 ? (
            <motion.div key="empty" {...revealMotion} className="flex min-h-[280px] items-center justify-center liquid-glass-modal-text-muted">
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
            </motion.div>
          ) : (
            <motion.div key="tables" {...revealMotion} className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {filteredTables.map((table) => (
                <button
                  key={table.id}
                  type="button"
                  onClick={() => handleTableClick(table)}
                  className="pos-glass-tap-card aspect-square min-h-touch p-3 transition focus-visible:outline-2 focus-visible:outline-yellow-400"
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
            </motion.div>
          )}
</AnimatePresence>
        </div>
      </div>
    </LiquidGlassModal>
  );
});

TableSelector.displayName = 'TableSelector';

export default TableSelector;
