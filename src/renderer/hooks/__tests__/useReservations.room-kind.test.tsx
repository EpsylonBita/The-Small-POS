import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('../../../lib', () => ({ onEvent: vi.fn(), offEvent: vi.fn() }));
vi.mock('../../services/ReservationsService', () => ({ reservationsService: {
  setContext: vi.fn(), fetchReservations: mocks.fetch, calculateStats: () => ({}),
} }));
import { useReservations } from '../useReservations';
afterEach(cleanup);
beforeEach(() => { mocks.fetch.mockReset(); });

it('refetches Today when switching tables to rooms and ignores the previous tab response', async () => {
  let resolveTables!: (value: unknown[]) => void;
  mocks.fetch.mockImplementation(({ kind }) => kind === 'table'
    ? new Promise((resolve) => { resolveTables = resolve; }) : Promise.resolve([{ id: 'room-booking' }]));
  const { result, rerender } = renderHook(({ kind }: { kind: 'table' | 'room' }) => useReservations({
    branchId: 'branch', organizationId: 'org', enableRealtime: false,
    filters: { dateFrom: '2026-09-08', dateTo: '2026-09-08', kind },
  }), { initialProps: { kind: 'table' } });
  rerender({ kind: 'room' });
  await waitFor(() => expect(result.current.reservations[0]?.id).toBe('room-booking'));
  await act(async () => resolveTables([{ id: 'stale-table' }]));
  expect(result.current.reservations[0]?.id).toBe('room-booking');
  expect(mocks.fetch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'room', dateFrom: '2026-09-08' }));
});
