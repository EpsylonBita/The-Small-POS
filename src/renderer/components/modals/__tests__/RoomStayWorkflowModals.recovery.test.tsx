import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  modules: new Set<string>(), get: vi.fn(), create: vi.fn(), arrive: vi.fn(), edit: vi.fn(), api: vi.fn(), offline: vi.fn(),
  t: (key: string, options?: any) => options?.defaultValue || key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('../../../../lib/i18n', () => ({ default: { language: 'en' } }));
vi.mock('../../../contexts/module-context', () => ({ useModules: () => ({ isModuleEnabled: (key: string) => mocks.modules.has(key) }) }));
vi.mock('../../../services/ReservationsService', () => ({ reservationsService: {
  setContext: vi.fn(), getActiveRoomReservation: mocks.get, createReservation: mocks.create,
  arriveRoomReservation: mocks.arrive, updateReservationDetails: mocks.edit,
} }));
vi.mock('../../../hooks/useHotelClock', () => ({useHotelClock: () => ({timeZone:'Europe/Athens',clock:()=>({date:'2026-10-20',time:'12:00'})})}));
vi.mock('../../../services/offline-mutations', () => ({ offlineRoomCheckin: mocks.offline }));
vi.mock('../../../utils/api-helpers', () => ({ posApiFetch: mocks.api }));
vi.mock('../../../services/RoomsService', () => ({ getRoomEffectiveStatus: (room: any) => room.status }));
vi.mock('../../ui/pos-glass-components', () => ({ LiquidGlassModal: ({ children, title }: any) => <div role="dialog" aria-label={title}>{children}</div> }));
import { RoomCheckinModal, RoomReservationModal } from '../RoomStayWorkflowModals';
const room = { id: 'room-101', roomNumber: '101', roomType: 'standard', ratePerNight: 145, capacity: 2, floor: 1, status: 'available' } as any;
const booking = { id: 'booking-id', roomId: room.id, reservationNumber: 'R-1', customerName: 'Guest', customerPhone: '123', partySize: 1, checkInDate: '2026-09-08', checkOutDate: '2026-09-10', status: 'pending' } as any;
const props = () => ({ room, branchId: 'branch', organizationId: 'org', updateRoomStatus: vi.fn(), refetchRooms: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), onCompleted: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks(); mocks.modules.clear(); mocks.modules.add('reservations');
  mocks.get.mockResolvedValue(null); mocks.create.mockResolvedValue(booking); mocks.arrive.mockResolvedValue(booking);
});
afterEach(cleanup);

it('prefills the existing booking and retries arrival without making a second reservation', async () => {
  mocks.arrive.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(booking);
  const callbacks = props(); render(<RoomCheckinModal {...callbacks} />);
  await waitFor(() => expect(mocks.get).toHaveBeenCalled());
  fireEvent.change(screen.getByRole('textbox', { name: 'Guest Name' }), { target: { value: 'Guest' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Phone' }), { target: { value: '123' } });
  const submit = screen.getByRole('button', { name: 'Complete Check-in' });
  await waitFor(() => expect(submit).toBeEnabled()); fireEvent.click(submit);
  expect(await screen.findByRole('alert')).toHaveTextContent('roomWorkflow.connectionError');
  fireEvent.click(submit);
  await waitFor(() => expect(callbacks.onCompleted).toHaveBeenCalledTimes(1));
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.arrive).toHaveBeenNthCalledWith(2, booking.id);
  expect(callbacks.updateRoomStatus).not.toHaveBeenCalled();
});
it('loads the booked guest and dates instead of a blank new arrival', async () => {
  mocks.get.mockResolvedValue(booking); render(<RoomCheckinModal {...props()} />);
  expect(await screen.findByDisplayValue('Guest')).toBeInTheDocument();
  expect(screen.getByDisplayValue('123')).toHaveAttribute('readonly');
  expect(screen.getByRole('spinbutton', { name: 'hotelDeskArrival.guestCount' })).toHaveValue(1);
  expect(screen.getByRole('spinbutton', { name: 'hotelDeskArrival.guestCount' })).toBeDisabled();
  expect(screen.getAllByRole('spinbutton')[1]).toHaveValue(2);
  expect(screen.getAllByRole('spinbutton')[1]).toBeDisabled();
  expect(screen.getByText(/2026-09-08 – 2026-09-10/)).toBeInTheDocument();
});
it.each([false, true])('pins a billed booking identity and guest count with reservations enabled=%s', async hasReservations => {
  if (!hasReservations) mocks.modules.clear();
  mocks.modules.add('guest_billing');
  mocks.api.mockResolvedValue({ success: true, data: { success: true } });
  const callbacks = props();
  render(<RoomCheckinModal {...callbacks} reservation={{ ...booking, status: 'confirmed' }} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Complete Check-in' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Complete Check-in' }));
  await waitFor(() => expect(callbacks.onCompleted).toHaveBeenCalledTimes(1));
  expect(JSON.parse(mocks.api.mock.calls[0][1].body)).toMatchObject({ clientRequestId: booking.id, expectedReservationId: booking.id, checkInDate: booking.checkInDate, checkOutDate: booking.checkOutDate, partySize: 1 });
});
it.each([undefined, 3])('sends the walk-in guest count %s rather than room capacity', async count => {
  mocks.modules.clear(); mocks.modules.add('guest_billing');
  mocks.api.mockResolvedValue({ success: true, data: { success: true } });
  render(<RoomCheckinModal {...props()} room={{...room, capacity: 6}} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Guest Name' }), { target: { value: 'Guest' } });
  expect(screen.getByLabelText('hotelDeskArrival.guestCount')).toHaveValue(1);
  if(count) fireEvent.change(screen.getByLabelText('hotelDeskArrival.guestCount'), {target:{value:String(count)}});
  fireEvent.click(screen.getByRole('button', { name: 'Complete Check-in' }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
  expect(JSON.parse(mocks.api.mock.calls[0][1].body).partySize).toBe(count || 1);
});
it('uses the entered guest count when creating a walk-in reservation without guest billing', async () => {
  render(<RoomCheckinModal {...props()} room={{...room, capacity: 6}} />);
  await waitFor(() => expect(mocks.get).toHaveBeenCalled());
  fireEvent.change(screen.getByRole('textbox', { name: 'Guest Name' }), { target: { value: 'Guest' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Phone' }), { target: { value: '123' } });
  fireEvent.change(screen.getByLabelText('hotelDeskArrival.guestCount'), {target:{value:'3'}});
  fireEvent.click(screen.getByRole('button', { name: 'Complete Check-in' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({partySize:3})));
});
it('retains the booked party size and identity in the offline arrival request', async () => {
  mocks.modules.add('guest_billing');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const callbacks=props();
  render(<RoomCheckinModal {...callbacks} room={{...room,capacity:6}} reservation={{...booking,status:'confirmed',partySize:3}} />);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Complete Check-in'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Complete Check-in'}));
  await waitFor(()=>expect(callbacks.onCompleted).toHaveBeenCalledTimes(1));
  expect(mocks.offline).toHaveBeenCalledWith(expect.objectContaining({roomId:room.id,organizationId:'org',branchId:'branch',
    partySize:3,expectedReservationId:booking.id,clientRequestId:booking.id}));
  expect(mocks.api).not.toHaveBeenCalled();
});
it('keeps the folio request id stable across a network failure', async () => {
  mocks.modules.clear(); mocks.modules.add('guest_billing');
  mocks.api.mockResolvedValueOnce({ success: false, error: 'offline' }).mockResolvedValue({ success: true, data: { success: true } });
  const callbacks = props(); render(<RoomCheckinModal {...callbacks} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Guest Name' }), { target: { value: 'Guest' } });
  fireEvent.click(screen.getByRole('button', { name: 'Complete Check-in' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Complete Check-in' }));
  await waitFor(() => expect(callbacks.onCompleted).toHaveBeenCalledTimes(1));
  expect(JSON.parse(mocks.api.mock.calls[0][1].body).clientRequestId).toBe(JSON.parse(mocks.api.mock.calls[1][1].body).clientRequestId);
});
it('requires phone, blocks reversed dates, and saves room/date edits through the existing update API', async () => {
  const callbacks = props(); render(<RoomReservationModal {...callbacks} reservation={booking} rooms={[room, { ...room, id: 'room-102', roomNumber: '102' }]} />);
  expect(screen.getByRole('textbox', { name: 'Phone' })).toBeRequired();
  fireEvent.change(screen.getByLabelText('Check-out Date'), { target: { value: '2026-09-07' } });
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(mocks.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Check-out Date'), { target: { value: '2026-09-11' } });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'room-102' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(mocks.edit).toHaveBeenCalledWith(booking.id, expect.objectContaining({ roomId: 'room-102', checkOutDate: '2026-09-11' })));
  expect(mocks.create).not.toHaveBeenCalled();
});

it.each([undefined,3])('records the actual guest count %s for future booked arrivals instead of capacity', async count => {
  render(<RoomReservationModal {...props()} room={{...room,capacity:6}} />);
  fireEvent.change(screen.getByRole('textbox',{name:'Guest Name'}),{target:{value:'Guest'}});
  fireEvent.change(screen.getByRole('textbox',{name:'Phone'}),{target:{value:'123'}});
  expect(screen.getByLabelText('hotelDeskArrival.guestCount')).toHaveValue(1);
  if(count) fireEvent.change(screen.getByLabelText('hotelDeskArrival.guestCount'),{target:{value:String(count)}});
  fireEvent.click(screen.getByRole('button',{name:'Create Reservation'}));
  await waitFor(()=>expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({partySize:count || 1})));
});

it('binds the server date-conflict booking and retries its own dates without needing a reservations read', async () => {
  mocks.modules.clear();mocks.modules.add('guest_billing');
  mocks.api.mockResolvedValueOnce({success:false,code:'ROOM_RESERVATION_DATES_MISMATCH',errorBody:{reservation:{id:booking.id,check_in_date:'2026-10-19',check_out_date:'2026-10-23',customer_name:'Booked Guest',customer_phone:'123',party_size:3,status:'confirmed'}}})
    .mockResolvedValue({success:true,data:{success:true}});
  const callbacks=props();render(<RoomCheckinModal {...callbacks} />);
  fireEvent.change(screen.getByRole('textbox',{name:'Guest Name'}),{target:{value:'Walk in'}});
  fireEvent.click(screen.getByRole('button',{name:'Complete Check-in'}));
  await screen.findByDisplayValue('Booked Guest');
  fireEvent.click(screen.getByRole('button',{name:'Complete Check-in'}));
  await waitFor(()=>expect(callbacks.onCompleted).toHaveBeenCalledTimes(1));
  expect(JSON.parse(mocks.api.mock.calls[1][1].body)).toMatchObject({expectedReservationId:booking.id,checkInDate:'2026-10-19',checkOutDate:'2026-10-23',partySize:3});
  expect(mocks.get).not.toHaveBeenCalled();
});

it('reads the actual party size when an older conflict snapshot omits it', async () => {
  mocks.modules.clear(); mocks.modules.add('guest_billing');
  mocks.get.mockResolvedValue({...booking,status:'confirmed',partySize:3});
  mocks.api.mockResolvedValueOnce({success:false,code:'ROOM_RESERVATION_DATES_MISMATCH',errorBody:{reservation:{id:booking.id,
    check_in_date:booking.checkInDate,check_out_date:booking.checkOutDate,customer_name:'Guest',status:'confirmed'}}})
    .mockResolvedValue({success:true,data:{success:true}});
  const callbacks=props(); render(<RoomCheckinModal {...callbacks} />);
  fireEvent.change(screen.getByRole('textbox',{name:'Guest Name'}),{target:{value:'Walk in'}});
  fireEvent.click(screen.getByRole('button',{name:'Complete Check-in'}));
  await waitFor(()=>expect(screen.getByLabelText('hotelDeskArrival.guestCount')).toHaveValue(3));
  fireEvent.click(screen.getByRole('button',{name:'Complete Check-in'}));
  await waitFor(()=>expect(callbacks.onCompleted).toHaveBeenCalledTimes(1));
  expect(JSON.parse(mocks.api.mock.calls[1][1].body)).toMatchObject({partySize:3,expectedReservationId:booking.id});
});
