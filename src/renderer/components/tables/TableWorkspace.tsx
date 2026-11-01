import React, { memo, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Clock3, LayoutGrid, Map, ReceiptText, Search, UserCheck, Users } from 'lucide-react';
import { useI18n } from '../../contexts/i18n-context';
import type { TableStatus } from '../../types/tables';
import './table-workspace.css';

// Founder 31/10 («ναι πάμε»): Tables, Rooms and Services share one workspace pattern -- a title with
// plain figures and the actions on one row, status chips with the kit's yellow, the app's own dropdown
// instead of the Windows one, floor groups, and one compact tile (glyph, number, detail, status).
// The pieces below are that pattern; RoomsView and AppointmentsView use them too.

export interface WorkspaceStat {
  key: string;
  label: string;
  value: React.ReactNode;
  /** Quiet trailing part of the value, e.g. "/18". */
  sub?: React.ReactNode;
}

export const WorkspaceHeader = ({ heading, stats, children, ...rest }: {
  heading: string;
  stats: WorkspaceStat[];
  children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) => (
  <header className="table-workspace-heading" {...rest}>
    <h2>{heading}</h2>
    <dl className="table-workspace-summary">
      {stats.map((stat) => (
        <div key={stat.key}><dt>{stat.label}</dt><dd>{stat.value}{stat.sub !== undefined && <span>{stat.sub}</span>}</dd></div>
      ))}
    </dl>
    {children && <div className="table-workspace-actions">{children}</div>}
  </header>
);

export interface WorkspaceChip<K extends string> {
  key: K;
  label: string;
  count?: number;
}

export function WorkspaceChips<K extends string>({ items, value, onChange, label }: {
  items: Array<WorkspaceChip<K>>;
  value: K;
  onChange: (key: K) => void;
  label: string;
}) {
  return (
    <div className="table-workspace-status-filters" role="group" aria-label={label}>
      {items.map((item) => (
        <button key={item.key} type="button" aria-pressed={value === item.key} onClick={() => onChange(item.key)}>
          {item.label}
          {item.count !== undefined && <>{' '}<span>{item.count}</span></>}
        </button>
      ))}
    </div>
  );
}

/** The app's dropdown: a button and a short list, closed by a tap outside or Escape. */
export function WorkspaceSelect<V extends string>({ value, options, onChange, label }: {
  value: V;
  options: Array<{ value: V; label: string }>;
  onChange: (value: V) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const current = options.find((option) => option.value === value) ?? options[0];
  return (
    <div ref={rootRef} className="table-workspace-select">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        aria-label={`${label}: ${current?.label ?? ''}`} onClick={() => setOpen((wasOpen) => !wasOpen)}>
        <span>{current?.label}</span><ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div id={listId} role="listbox" aria-label={label}>
          {options.map((option) => (
            <button key={option.value} type="button" role="option" aria-selected={option.value === value}
              onClick={() => { onChange(option.value); setOpen(false); }}>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const WorkspaceSearch = ({ value, onChange, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) => (
  <label className="table-workspace-search">
    <Search aria-hidden="true" />
    <input type="text" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
  </label>
);

export const WorkspaceIconButton = ({ label, onClick, children }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button type="button" className="table-workspace-icon-button" aria-label={label} onClick={onClick}>{children}</button>
);

/** A floor (or any) group of tiles: «Όροφος 1 · 18». */
export const WorkspaceGroup = ({ heading, count, children }: { heading: string; count: number; children: React.ReactNode }) => (
  <section className="table-workspace-group">
    <h3>{heading}<span>{count}</span></h3>
    {children}
  </section>
);

export interface TableWorkspaceStats {
  total: number;
  occupied: number;
  available: number;
  reserved: number;
  cleaning: number;
  due: number;
  occupancyRate: number;
}

interface ToolbarProps {
  stats: TableWorkspaceStats;
  statusLabels: Record<TableStatus, { label: string }>;
  statusFilter: TableStatus | 'all';
  onStatusFilter: (status: TableStatus | 'all') => void;
  floorFilter: string;
  floors: string[];
  floorLabel: (floor: string) => string;
  onFloorFilter: (floor: string) => void;
  onList: () => void;
  onFloorPlan: () => void;
  floorPlanOpen: boolean;
  formatCurrency: (value: number) => string;
}

export const TableWorkspaceToolbar = memo(({
  stats, statusLabels, statusFilter, onStatusFilter, floorFilter, floors,
  floorLabel, onFloorFilter, onList, onFloorPlan, floorPlanOpen, formatCurrency,
}: ToolbarProps) => {
  const { t } = useI18n();
  return (
    <div className="table-workspace-controls">
      <WorkspaceHeader
        heading={t('tables.title', 'Tables')}
        stats={[
          { key: 'occupied', label: t('tablesDashboard.occupied', 'Occupied'), value: stats.occupied, sub: `/${stats.total}` },
          { key: 'due', label: t('tablesDashboard.openDue', 'Open due'), value: formatCurrency(stats.due) },
          { key: 'rate', label: t('tablesDashboard.rate', 'Rate'), value: `${stats.occupancyRate}%` },
        ]}
      />
      <div className="table-workspace-toolbar">
        <WorkspaceChips<TableStatus | 'all'>
          label={t('tables.title', 'Tables')}
          value={statusFilter}
          onChange={onStatusFilter}
          items={(['all', 'available', 'occupied', 'reserved', 'cleaning'] as const).map((status) => ({
            key: status,
            label: status === 'all' ? t('tablesDashboard.all', 'All') : statusLabels[status].label,
            count: status === 'all' ? stats.total : stats[status],
          }))}
        />
        <span className="table-workspace-spacer" aria-hidden="true" />
        {/* One floor needs no picker; with more, the app's dropdown replaces the row of floor chips. */}
        {floors.length > 1 && (
          <WorkspaceSelect
            label={t('tablesDashboard.floor', 'Floor')}
            value={floorFilter}
            onChange={onFloorFilter}
            options={['all', ...floors].map((floor) => ({ value: floor, label: floorLabel(floor) }))}
          />
        )}
        <div className="table-workspace-view-mode">
          <button type="button" aria-pressed={!floorPlanOpen} onClick={onList}><LayoutGrid />{t('tablesDashboard.viewMode.list', 'List')}</button>
          <button type="button" aria-pressed={floorPlanOpen} onClick={onFloorPlan}><Map />{t('tablesDashboard.viewMode.floorPlan', '2D')}</button>
        </div>
      </div>
    </div>
  );
});
TableWorkspaceToolbar.displayName = 'TableWorkspaceToolbar';

interface CardProps {
  id: string; number: string; status: TableStatus; statusLabel: string;
  shape?: string | null; covers: string; waiter: string;
  hasOpenCheck: boolean; needsAttention: boolean; attentionLabel: string;
  balance: { due: number; total: number; paid: number }; paidPercent: number;
  occupiedSince: string | null; orderNumber?: string; formatCurrency: (value: number) => string;
  onPrimary: () => void;
}

/** Layered strokes draw the status glow (no blur filter, nothing animated per tile). */
const GlowGlyph = ({ outline, className = 'table-workspace-shape' }: { outline: string; className?: string }) => (
  <svg viewBox="-4 -4 56 48" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    <path d={outline} strokeWidth="9" className="table-shape-halo-outer" />
    <path d={outline} strokeWidth="6" className="table-shape-halo-middle" />
    <path d={outline} strokeWidth="3.5" className="table-shape-halo-inner" />
    <path d={outline} strokeWidth="1.8" />
    <path d={outline} stroke="#ffffff" strokeWidth="0.5" className="table-shape-core" />
  </svg>
);

export const TableShapeIcon = ({ shape }: { shape?: string | null }) => {
  const round = shape === 'circle' || shape === 'round' || shape === 'oval';
  const radius = shape === 'oval' ? 15 : 13;
  const outline = `${round
    ? `M${24 + radius} 20a${radius} 13 0 1 1-${radius * 2} 0a${radius} 13 0 1 1 ${radius * 2} 0`
    : 'M15 8h18a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3z'} M17 3h14 M17 37h14 M6 13v14 M42 13v14`;
  return <GlowGlyph outline={outline} />;
};

// Founder 31/10: a room is a double bed with sparkles, glowing in its status colour like a table.
// Headboard, two pillows, mattress with its seam, legs; two four-point sparkles and two small plus signs.
export const ROOM_BED_OUTLINE = 'M10 22V14a3 3 0 0 1 3-3h22a3 3 0 0 1 3 3v8 '
  + 'M14 22v-4a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v4 M25 22v-4a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v4 '
  + 'M7 34V26a4 4 0 0 1 4-4h26a4 4 0 0 1 4 4v8z M7 29h34 M10 34v4 M38 34v4 '
  + 'M15 2.8q.7 2.5 3.2 3.2q-2.5.7-3.2 3.2q-.7-2.5-3.2-3.2q2.5-.7 3.2-3.2z M22 1v4 M20 3h4 '
  + 'M27 4.8v2.4 M25.8 6h2.4 M33 1.5q.65 2.35 3 3q-2.35.65-3 3q-.65-2.35-3-3q2.35-.65 3-3z';

export const RoomBedIcon = () => <GlowGlyph outline={ROOM_BED_OUTLINE} />;

/** The compact tile opens the parent's context-aware table/check workflow. */
export const TableWorkspaceCard = memo(({
  id, number, status, statusLabel, shape, covers, waiter, hasOpenCheck,
  needsAttention, attentionLabel, balance, paidPercent, occupiedSince, orderNumber, formatCurrency, onPrimary,
}: CardProps) => {
  const { t } = useI18n();
  return <button type="button" className="table-workspace-card" data-status={status} data-table-id={id}
    aria-label={number + ' · ' + statusLabel + (needsAttention ? ' · ' + attentionLabel : '')} onClick={onPrimary}>
    <span className="table-workspace-tile">
      <TableShapeIcon shape={shape} />
      <span className="table-workspace-tile-info">
        <strong className="table-workspace-number">{number}</strong>
        <span className="table-workspace-meta"><Users aria-hidden="true" />{hasOpenCheck ? covers : t('tables.seats', { count: Number(covers), defaultValue: '{{count}} seats' })}</span>
        <span className="table-workspace-status"><i aria-hidden="true" />{statusLabel}</span>
      </span>
    </span>
    {hasOpenCheck && <span className="table-workspace-check">
      <span className="table-workspace-balance">
        <span>{t('tablesDashboard.due', 'Due')} <strong className={balance.due > 0 ? 'table-workspace-due' : 'table-workspace-paid'}>{formatCurrency(balance.due)}</strong></span>
        <span>{t('tablesDashboard.total', 'Total')} {formatCurrency(balance.total)} · {t('tablesDashboard.paid', 'Paid')} {formatCurrency(balance.paid)}</span>
      </span>
      <span className="table-workspace-progress" role="progressbar" aria-label={t('tablesDashboard.paid', 'Paid')} aria-valuenow={paidPercent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: paidPercent + '%' }} /></span>
      <span className="table-workspace-check-meta">
        <span><UserCheck aria-hidden="true" />{waiter}</span>
        {occupiedSince && <span><Clock3 aria-hidden="true" />{occupiedSince}</span>}
        {orderNumber && <span><ReceiptText aria-hidden="true" />{orderNumber}</span>}
      </span>
    </span>}
    {needsAttention && <span className="table-workspace-attention">{attentionLabel}</span>}
  </button>;
});
TableWorkspaceCard.displayName = 'TableWorkspaceCard';
