import React, { memo, useEffect, useMemo, useRef } from 'react';
import type { RestaurantTable, TableStatus } from '../../types/tables';
import { useI18n } from '../../contexts/i18n-context';
import {
  getTableFloorPlanLayout,
  getTableFloorPlanLayoutForCanvas,
  getTableShapePathForFloorPlan,
} from '../../utils/tableFloorPlan';
import { resolveTableDisplayStatus } from '../../utils/tableOrderFlow';
import { formatTableDisplayNumber } from '../../utils/table-display';
import { getFixturePreset } from '../../utils/floorPlanFixtures';
import './table-floor-plan.css';

/** Wall segment as the admin editor persists it on floor_plans.walls. */
export interface FloorPlanWallSegment {
  id: string;
  points: number[][];
  thickness: number;
  color: string;
  kind: string;
}

/** Placed fixture as the admin editor persists it on floor_plans.fixtures. */
export interface FloorPlanPlacedFixture {
  id: string;
  presetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  label?: string | null;
}

interface TableFloorPlanViewProps {
  tables: RestaurantTable[];
  isDark: boolean;
  selectedTableId?: string | null;
  onTableSelect: (table: RestaurantTable) => void;
  className?: string;
  /** Admin floor-plan decor: structural walls painted behind the tables. */
  walls?: FloorPlanWallSegment[];
  /** Admin floor-plan decor: placed fixtures (bar, plants, doors, …). */
  fixtures?: FloorPlanPlacedFixture[];
  /**
   * Admin canvas dimensions. When present the layout uses ABSOLUTE canvas
   * coordinates (no cluster normalization) so tables line up with the
   * walls/fixtures the admin placed.
   */
  canvas?: { width: number; height: number } | null;
  /**
   * Scale the whole plan to fill the container (SVG viewBox fit) instead of
   * rendering 1:1 pixels inside a scroll area. Used by the full-screen modal.
   */
  fit?: boolean;
  /**
   * Animate attention states: occupied tables pulse, cleaning tables get a
   * marching dashed ring — so the eye separates them at a glance (founder
   * request 30/08).
   */
  animated?: boolean;
}

const statusColors: Record<TableStatus, string> = {
  available: '#16a34a', occupied: '#f59e0b', reserved: '#3b82f6',
  cleaning: '#9ca3af', maintenance: '#f97316', unavailable: '#71717a',
};

export const TableFloorPlanView: React.FC<TableFloorPlanViewProps> = memo(({
  tables,
  isDark,
  selectedTableId = null,
  onTableSelect,
  className = '',
  fit = false,
  walls = [],
  fixtures = [],
  canvas = null,
}) => {
  const { t } = useI18n();
  // Normalized layout: every node is translated so the cluster starts at the
  // standard padding, so high/offset coordinates no longer open the 2D viewport
  // on empty leading space. With an admin canvas the coordinates stay
  // absolute instead, so tables align with the walls/fixtures.
  const layout = useMemo(
    () => (canvas ? getTableFloorPlanLayoutForCanvas(tables, canvas) : getTableFloorPlanLayout(tables)),
    [tables, canvas],
  );
  const bounds = layout.bounds;
  const nodes = useMemo(
    () => layout.nodes.map((node, index) => ({
      table: tables[index],
      node,
      status: resolveTableDisplayStatus(tables[index]),
    })),
    [layout, tables],
  );

  // Reset the inner floor-plan scroll to the top-left whenever the visible table
  // set/layout changes (and on mount). With the normalized layout above, a narrow
  // filtered set such as one reserved table then opens with that table visible
  // instead of a blank grid that needs manual inner scrolling.
  const scrollRef = useRef<HTMLDivElement>(null);
  const layoutSignature = useMemo(
    () => layout.nodes.map((node) => `${node.id}:${node.x}:${node.y}`).join('|'),
    [layout],
  );
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  }, [layoutSignature]);

  const statusLabel = (status: TableStatus) =>
    t(`tablesDashboard.tableStatus.${status}`, {
      defaultValue: status.charAt(0).toUpperCase() + status.slice(1),
    });
  if (tables.length === 0) {
    return (
      <div
        data-testid="tables-floor-plan-view"
        className={`flex h-full min-h-[320px] items-center justify-center rounded-xl border border-dashed ${
          isDark ? 'border-white/15 text-white/50' : 'border-slate-300 text-slate-500'
        } ${className}`}
      >
        <p className="text-sm font-semibold">
          {t('tablesDashboard.noMatchingTables', { defaultValue: 'No tables match these filters' })}
        </p>
      </div>
    );
  }

  const svgPlan = (
    <svg
      className={fit ? 'h-full w-full' : 'absolute inset-0 h-full w-full'}
      {...(fit ? {} : { width: bounds.width, height: bounds.height })}
      viewBox={`0 0 ${bounds.width} ${bounds.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={t('tablesDashboard.floorPlanAriaLabel', {
        defaultValue: 'Table floor plan',
      })}
    >
      <defs>
        <pattern id="pos-table-floor-grid" width="32" height="32" patternUnits="userSpaceOnUse">
          <path
            d="M 32 0 L 0 0 0 32"
            fill="none"
            stroke={isDark ? '#35383c' : '#e4e6e9'}
            strokeWidth="1"
            opacity="0.24"
          />
        </pattern>
      </defs>
      <rect
        x="0"
        y="0"
        width={bounds.width}
        height={bounds.height}
        rx="18"
        fill={isDark ? '#101113' : '#f8f9fa'}
      />
      <rect
        x="0"
        y="0"
        width={bounds.width}
        height={bounds.height}
        rx="18"
        fill="url(#pos-table-floor-grid)"
      />
      <rect
        x="16"
        y="16"
        width={Math.max(0, bounds.width - 32)}
        height={Math.max(0, bounds.height - 32)}
        rx="12"
        fill="none"
        stroke={isDark ? '#464c54' : '#c9ced6'}
        strokeWidth="2"
        opacity="0.8"
        pointerEvents="none"
      />

      {/* Structural walls — painted before fixtures and tables, mirroring the
          admin editor's paint order, so the skeleton sits behind furniture. */}
      {walls.map((wall, index) => (
        <polyline
          key={`${wall.id || 'wall'}-${index}`}
          points={(wall.points ?? []).map((p) => `${p[0]},${p[1]}`).join(' ')}
          fill="none"
          stroke={isDark ? '#626a74' : '#9ba3af'}
          strokeWidth={wall.thickness || 8}
          strokeLinecap="butt"
          strokeLinejoin="miter"
          strokeDasharray={wall.kind === 'partition' ? '12 6' : undefined}
          pointerEvents="none"
        />
      ))}

      {/* Placed fixtures (decor) — same glyph library the admin editor uses. */}
      <g className="floor-plan-fixtures">
      {fixtures.map((fixture, index) => {
        const preset = getFixturePreset(fixture.presetId);
        const width = fixture.width ?? preset?.defaultWidth ?? 60;
        const height = fixture.height ?? preset?.defaultHeight ?? 60;
        const rotation = fixture.rotation ?? 0;
        return (
          <g
            key={`${fixture.id || 'fixture'}-${index}`}
            transform={`translate(${fixture.x ?? 0}, ${fixture.y ?? 0}) rotate(${rotation}, ${width / 2}, ${height / 2})`}
            pointerEvents="none"
          >
            <rect
              x={0}
              y={0}
              width={width}
              height={height}
              fill={preset?.bgColor === 'transparent' ? 'transparent' : isDark ? '#24272b' : '#e9ecf0'}
              stroke={isDark ? '#626a74' : '#9ba3af'}
              strokeWidth={2}
              rx={4}
              strokeDasharray={undefined}
            />
            {preset ? preset.renderGlyph(width, height) : null}
            {fixture.label ? (
              <text
                x={width / 2}
                y={-4}
                fontSize={11}
                textAnchor="middle"
                fill={isDark ? '#aeb4bc' : '#58616c'}
                fontWeight="500"
              >
                {fixture.label}
              </text>
            ) : null}
          </g>
        );
      })}

      </g>
      {nodes.map(({ table, node, status }) => {
        const colors = { fill: isDark ? '#24272b' : '#ffffff', stroke: isDark ? '#626a74' : '#9ba3af', text: isDark ? '#f8fafc' : '#18181b' };
        const selected = selectedTableId === table.id;
        const path = getTableShapePathForFloorPlan(node.shape, node.width, node.height);
        // Display only: route the visible SVG text, aria-label and <title>
        // through the same shared formatter the list card / TableActionModal
        // use, so a raw label like "P01" renders as "#TP01" everywhere. The
        // raw node.label / table value is never mutated (matching/payloads
        // continue to read it directly).
        const label = formatTableDisplayNumber(node.label);
        const tableDescription = `${label} ${statusLabel(status)}`;

        return (
          <g
            key={node.id}
            role="button"
            tabIndex={0}
            aria-label={tableDescription}
            transform={`translate(${node.x}, ${node.y}) rotate(${node.rotation}, ${node.width / 2}, ${node.height / 2})`}
            className="floor-plan-table-node cursor-pointer"
            onClick={() => onTableSelect(table)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onTableSelect(table);
              }
            }}
          >
            <title>{tableDescription}</title>
            {selected ? (
              <rect
                x="-8"
                y="-8"
                width={node.width + 16}
                height={node.height + 16}
                rx="12"
                fill="none"
                stroke="#eab308"
                strokeWidth="3"

              />
            ) : null}
            <path
              d={path}
              fill={colors.fill}
              stroke={selected ? '#eab308' : colors.stroke}
              strokeWidth={selected ? 3 : 2}
            />
            <circle cx={node.width / 2} cy={Math.max(7, node.height / 2 - 23)} r={3.5} fill={statusColors[status]} pointerEvents="none" />
            <text
              x={node.width / 2}
              y={node.height / 2 - 3}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={colors.text}
              fontSize="14"
              fontWeight="600"
              style={{ userSelect: 'none', pointerEvents: 'none' }}
            >
              {label}
            </text>
            <text
              x={node.width / 2}
              y={node.height / 2 + 13}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={colors.text}
              fontSize="10"
              fontWeight="400"
              opacity="0.72"
              style={{ userSelect: 'none', pointerEvents: 'none' }}
            >
              {t('tables.seats', { count: node.capacity ?? table.capacity, defaultValue: '{{count}} seats' })}
            </text>
          </g>
        );
      })}
    </svg>
  );

  const legend = (
    <div className={`absolute bottom-3 left-3 flex flex-wrap gap-2 rounded-lg px-3 py-2 text-xs font-semibold shadow-sm ${
      isDark ? 'bg-[#1b1d20] text-zinc-200' : 'bg-white text-zinc-700'
    }`}>
      {(Object.keys(statusColors) as TableStatus[]).map(status => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: statusColors[status] }}
          />
          {statusLabel(status)}
        </span>
      ))}
    </div>
  );

  if (fit) {
    // Fit mode (full-screen modal): the SVG scales to fill the container via
    // its viewBox, so the plan is as large as the screen allows — no inner
    // scrolling, no tiny 1:1 tables.
    return (
      <div
        data-testid="tables-floor-plan-view"
        data-theme={isDark ? 'dark' : 'light'}
        className={`table-floor-plan relative h-full w-full overflow-hidden rounded-xl ${
          isDark ? 'bg-[#101113]' : 'bg-[#f8f9fa]'
        } ${className}`}
      >
        {svgPlan}
        {legend}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      data-testid="tables-floor-plan-view"
      data-theme={isDark ? 'dark' : 'light'}
      className={`table-floor-plan floor-plan-scrollbar scrollbar-hide h-full min-h-[360px] overflow-auto rounded-xl ${
        isDark ? 'bg-[#101113]' : 'bg-[#f8f9fa]'
      } ${className}`}
    >
      <div
        className="relative"
        style={{ width: bounds.width, height: bounds.height }}
      >
        {svgPlan}
        {legend}
      </div>
    </div>
  );
});

TableFloorPlanView.displayName = 'TableFloorPlanView';

export default TableFloorPlanView;
