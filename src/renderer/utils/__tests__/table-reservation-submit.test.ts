import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib', () => ({ getBridge: () => ({}), isBrowser: () => false }));
vi.mock('../api-helpers', () => ({ posApiGet: vi.fn(), posApiPatch: vi.fn(), posApiPost: vi.fn() }));

import type { Reservation } from '../../services/ReservationsService';
import { submitTableReservation } from '../table-reservation-submit';

const service = {
  setContext: vi.fn(),
  createReservationWithTableUpdate: vi.fn(),
  updateReservationDetails: vi.fn(),
};

// 24/09/2026 19:30 local time, as the ReservationForm hands it over.
const data = {
  customerName: 'Maria',
  customerPhone: '6900000000',
  reservationTime: new Date(2026, 8, 24, 19, 30),
  partySize: 4,
  specialRequests: 'Window',
  tableId: 'table-7',
};

const existing: Reservation = {
  id: 'booking-1',
  organizationId: 'org-1',
  branchId: 'branch-1',
  reservationNumber: 'RES-20260924-0001',
  customerId: null,
  customerName: 'Maria',
  customerPhone: '6900000000',
  customerEmail: null,
  partySize: 2,
  tableId: 'table-7',
  roomId: null,
  checkInDate: null,
  checkOutDate: null,
  reservationDate: '2026-09-24',
  reservationTime: '19:30',
  reservationDatetime: '2026-09-24T19:30:00',
  durationMinutes: 90,
  status: 'confirmed',
  specialRequests: 'Window',
  notes: null,
  confirmedAt: null,
  seatedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

describe('submitTableReservation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('books the table for the branch and organization of the terminal', async () => {
    const result = await submitTableReservation(
      { data, editingReservation: null, branchId: 'branch-1', organizationId: 'org-1' },
      service,
    );

    expect(result).toBe('created');
    expect(service.setContext).toHaveBeenCalledWith('branch-1', 'org-1');
    expect(service.createReservationWithTableUpdate).toHaveBeenCalledWith({
      customerName: 'Maria',
      customerPhone: '6900000000',
      partySize: 4,
      reservationDate: '2026-09-24',
      reservationTime: '19:30',
      tableId: 'table-7',
      specialRequests: 'Window',
    });
    expect(service.updateReservationDetails).not.toHaveBeenCalled();
  });

  it('touches nothing without a branch or an organization', async () => {
    expect(
      await submitTableReservation(
        { data, editingReservation: null, branchId: null, organizationId: 'org-1' },
        service,
      ),
    ).toBe('missing-context');
    expect(
      await submitTableReservation(
        { data, editingReservation: null, branchId: 'branch-1', organizationId: undefined },
        service,
      ),
    ).toBe('missing-context');
    expect(service.setContext).not.toHaveBeenCalled();
    expect(service.createReservationWithTableUpdate).not.toHaveBeenCalled();
  });

  it('saves only what changed on an edit', async () => {
    const result = await submitTableReservation(
      { data, editingReservation: existing, branchId: 'branch-1', organizationId: 'org-1' },
      service,
    );

    expect(result).toBe('updated');
    expect(service.updateReservationDetails).toHaveBeenCalledWith('booking-1', { partySize: 4 });
    expect(service.createReservationWithTableUpdate).not.toHaveBeenCalled();
  });

  it('sends nothing for an edit that changed nothing', async () => {
    const result = await submitTableReservation(
      {
        data: { ...data, partySize: 2 },
        editingReservation: existing,
        branchId: 'branch-1',
        organizationId: 'org-1',
      },
      service,
    );

    expect(result).toBe('updated');
    expect(service.updateReservationDetails).not.toHaveBeenCalled();
  });

  it('lets the caller word a service failure', async () => {
    service.createReservationWithTableUpdate.mockRejectedValueOnce(new Error('TABLE_UNAVAILABLE'));

    await expect(
      submitTableReservation(
        { data, editingReservation: null, branchId: 'branch-1', organizationId: 'org-1' },
        service,
      ),
    ).rejects.toThrow('TABLE_UNAVAILABLE');
  });
});
