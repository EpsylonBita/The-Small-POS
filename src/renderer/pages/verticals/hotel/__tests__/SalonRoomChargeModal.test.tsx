import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), context: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../components/ui/pos-glass-components', () => ({ LiquidGlassModal: ({children}: any) => <div role="dialog">{children}</div> }));
vi.mock('../../../../services/RoomsService', () => ({
  getRoomEffectiveStatus: (room: any) => room.effectiveStatus || room.status,
  roomsService: {fetchRooms:mocks.fetch,setContext:mocks.context},
}));
vi.mock('../../../../utils/store-currency', () => ({ getStoreCurrency: () => 'CHF' }));
import { SalonRoomChargeModal } from '../SalonRoomChargeModal';
const room = { id:'room-1',roomNumber:'101',organizationId:'org',branchId:'branch',status:'occupied',
  activeFolio:{id:'folio-1',guestName:'Guest',currency:'CHF'} };
beforeEach(() => { vi.clearAllMocks(); mocks.fetch.mockResolvedValue([room]); });
afterEach(cleanup);
it('pins an occupied room and active folio without taking payment or losing their currency', async () => {
  const select=vi.fn();
  render(<SalonRoomChargeModal organizationId="org" branchId="branch" onSelect={select} onClose={vi.fn()} />);
  await screen.findByRole('option',{name:'101 · Guest'});
  expect(mocks.context).toHaveBeenCalledWith('branch','org');
  expect(screen.getByRole('button',{name:'hotelDeskService.useRoom'})).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'room-1'}});
  fireEvent.click(screen.getByRole('button',{name:'hotelDeskService.useRoom'}));
  expect(select).toHaveBeenCalledWith({roomId:'room-1',roomNumber:'101',activeFolioId:'folio-1',guestName:'Guest',currency:'CHF'});
});
it('excludes other scopes, vacant rooms, missing folios and incompatible currencies', async () => {
  mocks.fetch.mockResolvedValue([
    {...room,organizationId:'other'}, {...room,branchId:'other'}, {...room,status:'available'},
    {...room,activeFolio:null}, {...room,activeFolio:{...room.activeFolio,currency:null}},
    {...room,activeFolio:{...room.activeFolio,currency:'EUR'}},
  ]);
  const select=vi.fn();
  render(<SalonRoomChargeModal organizationId="org" branchId="branch" onSelect={select} onClose={vi.fn()} />);
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('hotelDeskService.noRooms'));
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(screen.getByRole('button',{name:'hotelDeskService.useRoom'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'hotelDeskService.collectNow'}));
  expect(select).toHaveBeenCalledWith(null);
});
it('keeps ordinary collection available when room lookup fails', async () => {
  mocks.fetch.mockRejectedValue(new Error('offline'));
  const select=vi.fn();
  render(<SalonRoomChargeModal organizationId="org" branchId="branch" onSelect={select} onClose={vi.fn()} />);
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('hotelDeskService.noRooms'));
  fireEvent.click(screen.getByRole('button',{name:'hotelDeskService.collectNow'}));
  expect(select).toHaveBeenCalledWith(null);
});
