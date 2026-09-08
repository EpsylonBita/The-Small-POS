import { beforeEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ reservations: { get: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn() } }));
vi.mock('../../../lib', () => ({ getBridge: () => bridge, isBrowser: () => false }));
vi.mock('../../utils/api-helpers', () => ({ posApiGet: vi.fn(), posApiPatch: vi.fn(), posApiPost: vi.fn() }));
import { reservationsService } from '../ReservationsService';
const booking = { id: 'booking-1', room_id: 'room-101', status: 'pending', check_in_date: '2026-09-08', check_out_date: '2026-09-10' };
const response = (reservation: unknown) => ({ success: true, data: { success: true, reservation } });
beforeEach(() => { vi.clearAllMocks(); reservationsService.setContext('branch', 'org'); });

it('confirms then arrives through legal statuses; a failed arrival retry never creates another booking', async () => {
  let current = { ...booking };
  let shouldFail = true;
  bridge.reservations.get.mockImplementation(async () => response(current));
  bridge.reservations.update.mockImplementation(async (_id, { status }) => {
    if (status === 'seated' && shouldFail) { shouldFail = false; throw new Error('offline'); }
    current = { ...current, status }; return response(current);
  });
  await expect(reservationsService.arriveRoomReservation(booking.id)).rejects.toThrow('offline');
  expect(current.status).toBe('confirmed');
  await expect(reservationsService.arriveRoomReservation(booking.id)).resolves.toMatchObject({ status: 'seated' });
  expect(bridge.reservations.update.mock.calls.map(([, payload]) => payload.status)).toEqual(['confirmed','seated','seated']);
  expect(bridge.reservations.create).not.toHaveBeenCalled();
});
it('refuses terminal reservations and does not treat a failed lookup as an available room', async () => {
  bridge.reservations.get.mockResolvedValue(response({ ...booking, status: 'cancelled' }));
  await expect(reservationsService.arriveRoomReservation(booking.id)).rejects.toThrow('TERMINAL_RESERVATION');
  expect(bridge.reservations.update).not.toHaveBeenCalled();
  bridge.reservations.list.mockResolvedValue({ success: false, error: 'offline' });
  await expect(reservationsService.getActiveRoomReservation('room-101', '2026-09-08')).rejects.toThrow('offline');
});
