import React, { memo } from 'react';
import { Clock3, LayoutGrid, Map, ReceiptText, UserCheck, Users } from 'lucide-react';
import { useI18n } from '../../contexts/i18n-context';
import type { TableStatus } from '../../types/tables';
import './table-workspace.css';

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
      <header className="table-workspace-heading">
        <h2>{t('tables.title', 'Tables')}</h2>
        <dl className="table-workspace-summary">
          <div><dt>{t('tablesDashboard.occupied', 'Occupied')}</dt><dd>{stats.occupied}<span>/{stats.total}</span></dd></div>
          <div><dt>{t('tablesDashboard.openDue', 'Open due')}</dt><dd className="table-workspace-due">{formatCurrency(stats.due)}</dd></div>
          <div><dt>{t('tablesDashboard.rate', 'Rate')}</dt><dd>{stats.occupancyRate}%</dd></div>
        </dl>
      </header>
      <div className="table-workspace-toolbar">
        <div className="table-workspace-status-filters" aria-label={t('tables.title', 'Tables')}>
          {(['all', 'available', 'occupied', 'reserved', 'cleaning'] as const).map(status => (
            <button key={status} type="button" aria-pressed={statusFilter === status} onClick={() => onStatusFilter(status)}>
              {status === 'all' ? t('tablesDashboard.all', 'All') : statusLabels[status].label}
              {' '}
              <span>{status === 'all' ? stats.total : stats[status]}</span>
            </button>
          ))}
        </div>
        <div className="table-workspace-view-mode">
          <button type="button" aria-pressed={!floorPlanOpen} onClick={onList}><LayoutGrid />{t('tablesDashboard.viewMode.list', 'List')}</button>
          <button type="button" aria-pressed={floorPlanOpen} onClick={onFloorPlan}><Map />{t('tablesDashboard.viewMode.floorPlan', '2D')}</button>
        </div>
      </div>
      <div className="table-workspace-floors" aria-label={t('tablesDashboard.floor', 'Floor')}>
        {['all', ...floors].map(floor => (
          <button key={floor} type="button" aria-pressed={floorFilter === floor} onClick={() => onFloorFilter(floor)}>{floorLabel(floor)}</button>
        ))}
      </div>
    </div>
  );
});
TableWorkspaceToolbar.displayName = 'TableWorkspaceToolbar';

interface CardProps {
  id: string; number: string; status: TableStatus; statusLabel: string;
  shape?: string | null; floor: string; covers: string; waiter: string;
  hasOpenCheck: boolean; needsAttention: boolean; attentionLabel: string;
  balance: { due: number; total: number; paid: number }; paidPercent: number;
  occupiedSince: string | null; orderId?: string; formatCurrency: (value: number) => string;
  onPrimary: () => void;
}

export const TableShapeIcon = ({ shape }: { shape?: string | null }) => (
  <svg viewBox="0 0 48 40" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className="table-workspace-shape">
    {shape === 'circle' || shape === 'round' || shape === 'oval'
      ? <><ellipse cx="24" cy="20" rx={shape === 'oval' ? 15 : 13} ry="13" /><path d="M17 3h14M17 37h14M6 13v14M42 13v14" /></>
      : <><rect x="12" y="8" width="24" height="24" rx="3" /><path d="M17 3h14M17 37h14M6 13v14M42 13v14" /></>}
  </svg>
);

/** The compact tile opens the parent's context-aware table/check workflow. */
export const TableWorkspaceCard = memo(({
  id, number, status, statusLabel, shape, floor, covers, waiter, hasOpenCheck,
  needsAttention, attentionLabel, balance, paidPercent, occupiedSince, orderId, formatCurrency, onPrimary,
}: CardProps) => {
  const { t } = useI18n();
  return <button type="button" className="table-workspace-card" data-status={status} data-table-id={id}
    aria-label={number + ' · ' + statusLabel + (needsAttention ? ' · ' + attentionLabel : '')} onClick={onPrimary}>
    <TableShapeIcon shape={shape} />
    <strong className="table-workspace-number">{number}</strong>
    <span className="table-workspace-status"><i aria-hidden="true" />{statusLabel}</span>
    <span className="table-workspace-meta"><Users aria-hidden="true" />{hasOpenCheck ? covers : t('tables.seats', { count: Number(covers), defaultValue: '{{count}} seats' })}</span>
    <span className="table-workspace-floor">{floor}</span>
    {hasOpenCheck && <span className="table-workspace-check">
      <span className="table-workspace-balance">
        <span>{t('tablesDashboard.due', 'Due')} <strong className={balance.due > 0 ? 'table-workspace-due' : 'table-workspace-paid'}>{formatCurrency(balance.due)}</strong></span>
        <span>{t('tablesDashboard.total', 'Total')} {formatCurrency(balance.total)} · {t('tablesDashboard.paid', 'Paid')} {formatCurrency(balance.paid)}</span>
      </span>
      <span className="table-workspace-progress" role="progressbar" aria-label={t('tablesDashboard.paid', 'Paid')} aria-valuenow={paidPercent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: paidPercent + '%' }} /></span>
      <span className="table-workspace-check-meta">
        <span><UserCheck aria-hidden="true" />{waiter}</span>
        {occupiedSince && <span><Clock3 aria-hidden="true" />{occupiedSince}</span>}
        {orderId && <span><ReceiptText aria-hidden="true" />{orderId.slice(0, 10)}</span>}
      </span>
    </span>}
    {needsAttention && <span className="table-workspace-attention">{attentionLabel}</span>}
  </button>;
});
TableWorkspaceCard.displayName = 'TableWorkspaceCard';
