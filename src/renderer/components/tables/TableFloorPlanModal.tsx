import React, { useEffect, useMemo, useState } from 'react';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { X, Map as MapIcon } from 'lucide-react';
import type { RestaurantTable } from '../../types/tables';
import { useI18n } from '../../contexts/i18n-context';
import { getBridge } from '../../../lib';
import {
  TableFloorPlanView,
  type FloorPlanPlacedFixture,
  type FloorPlanWallSegment,
} from './TableFloorPlanView';
import { getTableFloorValue } from './TableSelector';

interface FloorPlanRow {
  id: string;
  name?: string | null;
  floor_level?: number | string | null;
  canvas_width?: number | null;
  canvas_height?: number | null;
  walls?: FloorPlanWallSegment[] | null;
  fixtures?: FloorPlanPlacedFixture[] | null;
  is_default?: boolean | null;
}

interface TableFloorPlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  tables: RestaurantTable[];
  isDark: boolean;
  selectedTableId?: string | null;
  onTableSelect: (table: RestaurantTable) => void;
}

/**
 * Full-screen 2D floor plan (founder 30/08): the inline 2D grid rendered the
 * plan 1:1 inside a short panel, so tables were tiny. The modal gives the plan
 * the whole screen, with floor filtering and the shared accessible modal shell.
 */
export const TableFloorPlanModal: React.FC<TableFloorPlanModalProps> = ({
  isOpen,
  onClose,
  tables,
  isDark,
  selectedTableId = null,
  onTableSelect,
}) => {
  const { t } = useI18n();
  const [floorFilter, setFloorFilter] = useState<string>('all');
  const [floorPlans, setFloorPlans] = useState<FloorPlanRow[]>([]);

  // Admin floor plans (walls + fixtures) so the modal shows the same picture
  // the admin editor draws. Best-effort: tables render fine without them.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const bridge = getBridge();
        const result = await bridge.tables.floorPlans();
        if (cancelled) return;
        const payload = (result?.data ?? result) as { floor_plans?: FloorPlanRow[] } | undefined;
        const plans = Array.isArray(payload?.floor_plans) ? payload.floor_plans : [];
        setFloorPlans(plans);
      } catch {
        if (!cancelled) setFloorPlans([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const floorOptions = useMemo(() => {
    const floors = Array.from(new Set(tables.map((table) => getTableFloorValue(table))));
    return floors.sort((left, right) => {
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return leftNumber - rightNumber;
      }
      return left.localeCompare(right);
    });
  }, [tables]);

  const effectiveFloor =
    floorFilter === 'all' || floorOptions.includes(floorFilter) ? floorFilter : 'all';

  const visibleTables = useMemo(
    () =>
      effectiveFloor === 'all'
        ? tables
        : tables.filter((table) => getTableFloorValue(table) === effectiveFloor),
    [tables, effectiveFloor],
  );

  // Decor is per-floor-plan (absolute canvas coordinates). A specific floor
  // renders its plan; "all floors" only when a single plan exists — mixing
  // canvases from different floors would overlap into nonsense.
  const activePlan = useMemo(() => {
    if (floorPlans.length === 0) return null;
    if (effectiveFloor === 'all') {
      return floorPlans.length === 1 ? floorPlans[0] : null;
    }
    return (
      floorPlans.find((plan) => String(plan.floor_level ?? '') === effectiveFloor) ?? null
    );
  }, [floorPlans, effectiveFloor]);

  const planCanvas = useMemo(() => {
    if (!activePlan) return null;
    const width = Number(activePlan.canvas_width);
    const height = Number(activePlan.canvas_height);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? { width, height }
      : null;
  }, [activePlan]);

  if (!isOpen || typeof document === 'undefined') return null;

  const floorLabel = (floor: string) =>
    floor === 'all'
      ? t('tablesDashboard.allFloors', 'All floors')
      : t('tablesDashboard.floorNumber', { defaultValue: 'Floor {{floor}}', floor });

  const chipClass = (active: boolean) =>
    `whitespace-nowrap min-h-[44px] rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
      active
        ? 'bg-yellow-400 text-black'
        : isDark
          ? 'text-slate-200 active:bg-white/[0.08]'
          : 'text-slate-700 active:bg-[#fffaf1]'
    }`;

  return <LiquidGlassModal isOpen={isOpen} onClose={onClose} closeMode="request" size="full" blur={false}
    ariaLabel={t('tablesDashboard.floorPlanAriaLabel', { defaultValue: 'Table floor plan' })}
    className={`floor-plan-dialog floor-plan-dialog--${isDark ? 'dark' : 'light'}`} contentClassName="floor-plan-dialog-content">
      <div data-testid="table-floor-plan-modal"
        className={`relative m-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border shadow-2xl sm:m-6 ${
          isDark ? 'border-[#35383c] bg-[#101113]' : 'border-[#dfe2e6] bg-[#f8f9fa]'
        }`}
      >
        <div
          className={`flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-6 ${
            isDark ? 'border-white/10' : 'border-[#dfe2e6]'
          }`}
        >
          <span
            className={`inline-flex items-center gap-2 text-lg font-semibold ${
              isDark ? 'text-white' : 'text-slate-900'
            }`}
          >
            <MapIcon className="h-5 w-5" />
            {t('tablesDashboard.viewMode.floorPlan', '2D')}
          </span>

          <div
            className={`flex flex-1 flex-wrap items-center gap-1 rounded-xl border p-1 ${
              isDark ? 'border-white/10 bg-white/[0.06]' : 'border-amber-100/80 bg-white'
            }`}
          >
            <button
              type="button"
              onClick={() => setFloorFilter('all')}
              aria-pressed={effectiveFloor === 'all'}
              className={chipClass(effectiveFloor === 'all')}
            >
              {floorLabel('all')}
            </button>
            {floorOptions.map((floor) => (
              <button
                key={floor}
                type="button"
                onClick={() => setFloorFilter(floor)}
                aria-pressed={effectiveFloor === floor}
                className={chipClass(effectiveFloor === floor)}
                data-testid={`floor-plan-modal-floor-${floor}`}
              >
                {floorLabel(floor)}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onClose}
            data-testid="table-floor-plan-modal-close"
            aria-label={t('common.actions.close', 'Close')}
            className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border transition-colors ${
              isDark
                ? 'border-white/15 bg-white/10 text-white active:bg-white/20'
                : 'border-slate-300/80 bg-white text-slate-700 active:bg-slate-100'
            }`}
          >
            <X className="h-5 w-5" strokeWidth={2.5} />
          </button>
        </div>

        <div className="min-h-0 flex-1 p-3 sm:p-4">
          <TableFloorPlanView
            tables={visibleTables}
            isDark={isDark}
            selectedTableId={selectedTableId}
            onTableSelect={onTableSelect}
            fit
            walls={activePlan?.walls ?? []}
            fixtures={activePlan?.fixtures ?? []}
            canvas={planCanvas}
            className="h-full"
          />
        </div>
      </div>
    </LiquidGlassModal>;
};

export default TableFloorPlanModal;
