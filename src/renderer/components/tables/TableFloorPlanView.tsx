import React, { memo, useMemo } from 'react';
import type { RestaurantTable, TableStatus } from '../../types/tables';
import { useI18n } from '../../contexts/i18n-context';
import {
  getTableFloorPlanBounds,
  getTableShapePathForFloorPlan,
  resolveTableFloorPlanNode,
} from '../../utils/tableFloorPlan';
import { resolveTableDisplayStatus } from '../../utils/tableOrderFlow';

interface TableFloorPlanViewProps {
  tables: RestaurantTable[];
  isDark: boolean;
  selectedTableId?: string | null;
  onTableSelect: (table: RestaurantTable) => void;
  className?: string;
}

const statusColors: Record<TableStatus, { fill: string; stroke: string; text: string }> = {
  available: { fill: '#86efac', stroke: '#16a34a', text: '#14141c' },
  occupied: { fill: '#fca5a5', stroke: '#dc2626', text: '#14141c' },
  reserved: { fill: '#fde68a', stroke: '#d97706', text: '#14141c' },
  cleaning: { fill: '#c4b5fd', stroke: '#7c3aed', text: '#14141c' },
  maintenance: { fill: '#fdba74', stroke: '#ea580c', text: '#14141c' },
  unavailable: { fill: '#e9e5e8', stroke: '#7a7186', text: '#14141c' },
};

export const TableFloorPlanView: React.FC<TableFloorPlanViewProps> = memo(({
  tables,
  isDark,
  selectedTableId = null,
  onTableSelect,
  className = '',
}) => {
  const { t } = useI18n();
  const nodes = useMemo(
    () => tables.map((table, index) => ({
      table,
      node: resolveTableFloorPlanNode(table, index),
      status: resolveTableDisplayStatus(table),
    })),
    [tables],
  );
  const bounds = useMemo(
    () => getTableFloorPlanBounds(tables),
    [tables],
  );

  const statusLabel = (status: TableStatus) =>
    t(`tablesDashboard.tableStatus.${status}`, {
      defaultValue: status.charAt(0).toUpperCase() + status.slice(1),
    });
  const paxLabel = t('floorPlan.tableProperties.pax', { defaultValue: 'pax' });

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

  return (
    <div
      data-testid="tables-floor-plan-view"
      className={`floor-plan-scrollbar ${isDark ? 'floor-plan-scrollbar-dark' : 'floor-plan-scrollbar-light'} h-full min-h-[360px] overflow-auto rounded-xl ${
        isDark ? 'bg-black/20' : 'bg-[#fffdf8]/70'
      } ${className}`}
    >
      <div
        className="relative"
        style={{ width: bounds.width, height: bounds.height }}
      >
        <svg
          className="absolute inset-0 h-full w-full"
          width={bounds.width}
          height={bounds.height}
          viewBox={`0 0 ${bounds.width} ${bounds.height}`}
          role="img"
          aria-label={t('tablesDashboard.floorPlanAriaLabel', {
            defaultValue: 'Table floor plan',
          })}
        >
          <defs>
            <pattern id="pos-table-floor-grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path
                d="M 32 0 L 0 0 0 32"
                fill="none"
                stroke={isDark ? '#243044' : '#e8dcc9'}
                strokeWidth="1"
                opacity="0.55"
              />
            </pattern>
          </defs>
          <rect
            x="0"
            y="0"
            width={bounds.width}
            height={bounds.height}
            rx="18"
            fill={isDark ? '#080d16' : '#fffaf1'}
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
            stroke={isDark ? '#475569' : '#c7b99f'}
            strokeWidth="2"
            opacity="0.8"
            pointerEvents="none"
          />

          {nodes.map(({ table, node, status }) => {
            const colors = statusColors[status] || statusColors.available;
            const selected = selectedTableId === table.id;
            const path = getTableShapePathForFloorPlan(node.shape, node.width, node.height);
            const label = String(node.label).startsWith('#') ? String(node.label) : `#${node.label}`;
            const tableDescription = `${label} ${statusLabel(status)}`;

            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={tableDescription}
                transform={`translate(${node.x}, ${node.y}) rotate(${node.rotation}, ${node.width / 2}, ${node.height / 2})`}
                className="cursor-pointer outline-none"
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
                    strokeDasharray="7 4"
                  />
                ) : null}
                <path
                  d={path}
                  fill={colors.fill}
                  stroke={selected ? '#eab308' : colors.stroke}
                  strokeWidth={selected ? 3 : 2}
                  opacity="0.96"
                  style={{
                    filter: selected
                      ? 'drop-shadow(0 12px 18px rgba(234, 179, 8, 0.28))'
                      : 'drop-shadow(0 5px 10px rgba(15, 23, 42, 0.18))',
                  }}
                />
                <text
                  x={node.width / 2}
                  y={node.height / 2 - 6}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={colors.text}
                  fontSize="14"
                  fontWeight="800"
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
                  fontWeight="700"
                  opacity="0.72"
                  style={{ userSelect: 'none', pointerEvents: 'none' }}
                >
                  {node.capacity ?? table.capacity} {paxLabel}
                </text>
              </g>
            );
          })}
        </svg>

        <div className={`absolute bottom-3 left-3 flex flex-wrap gap-2 rounded-lg px-3 py-2 text-xs font-semibold shadow-sm ${
          isDark ? 'bg-slate-950/80 text-slate-200' : 'bg-white/85 text-slate-700'
        }`}>
          {(Object.keys(statusColors) as TableStatus[]).map(status => (
            <span key={status} className="inline-flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: statusColors[status].stroke }}
              />
              {statusLabel(status)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
});

TableFloorPlanView.displayName = 'TableFloorPlanView';

export default TableFloorPlanView;
