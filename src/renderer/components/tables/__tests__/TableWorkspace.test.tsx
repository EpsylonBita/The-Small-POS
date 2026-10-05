import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TableWorkspaceCard, TableWorkspaceToolbar } from '../TableWorkspace';
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ t: (key: string, fallback: string | Record<string, unknown>) => {
  const text = typeof fallback === 'string' ? fallback : String(fallback?.defaultValue ?? key);
  return typeof fallback === 'object' ? text.replace('{{count}}', String(fallback.count)) : text;
} }) }));
afterEach(cleanup);
const money = (value: number) => `${value.toFixed(2)} €`;
const base = { id: 't1', number: '#TB01', status: 'available' as const, statusLabel: 'Available', floor: 'Floor 1', covers: '4', waiter: 'Unassigned', hasOpenCheck: false, needsAttention: false, attentionLabel: 'Mark cleaned', balance: { due: 0, total: 0, paid: 0 }, paidPercent: 0, occupiedSince: null, formatCurrency: money };
describe('compact table workspace', () => {
  it('makes the whole tile one selection target with capacity and status', () => {
    const select = vi.fn(); render(<TableWorkspaceCard {...base} onPrimary={select} />);
    expect(screen.getByText('4 seats')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '#TB01 · Available' }));
    expect(select).toHaveBeenCalledOnce();
  });
  it.each(['cleaning', 'maintenance', 'unavailable'] as const)('%s retains its warning and selection route', status => {
    const select = vi.fn(); render(<TableWorkspaceCard {...base} status={status} needsAttention onPrimary={select} />);
    expect(screen.getByText('Mark cleaned')).toBeTruthy();
    fireEvent.click(screen.getByRole('button')); expect(select).toHaveBeenCalledOnce();
    expect(screen.queryByText('New order')).toBeNull();
  });
  it('retains the open check amount, guests, waiter and paid progress', () => {
    render(<TableWorkspaceCard {...base} status="occupied" statusLabel="Occupied" hasOpenCheck covers="2/4" balance={{ due: 23, total: 33.5, paid: 10.5 }} paidPercent={31} onPrimary={vi.fn()} />);
    expect(screen.getByText('23.00 €')).toBeTruthy();
    expect(screen.getByText('2/4')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '31');
    expect(screen.getByText('Unassigned')).toBeTruthy();
  });
  it('toolbar keeps controlled filters and List/2D actions', () => {
    const status = vi.fn(), floor = vi.fn(), map = vi.fn();
    const labels = Object.fromEntries(['available', 'occupied', 'reserved', 'cleaning', 'maintenance', 'unavailable'].map(key => [key, { label: key }])) as any;
    render(<TableWorkspaceToolbar stats={{ total: 18, occupied: 0, available: 17, reserved: 0, cleaning: 1, due: 0, occupancyRate: 0 }} statusLabels={labels} statusFilter="all" onStatusFilter={status} floorFilter="all" floors={['1', '2']} floorLabel={value => value === 'all' ? 'All floors' : `Floor ${value}`} onFloorFilter={floor} onList={vi.fn()} onFloorPlan={map} floorPlanOpen={false} formatCurrency={money} />);
    fireEvent.click(screen.getByRole('button', { name: 'cleaning 1' })); expect(status).toHaveBeenCalledWith('cleaning');
    fireEvent.click(screen.getByRole('button', { name: 'Floor 2' })); expect(floor).toHaveBeenCalledWith('2');
    fireEvent.click(screen.getByRole('button', { name: '2D' })); expect(map).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'All 18' })).toHaveAttribute('aria-pressed', 'true');
  });
});
