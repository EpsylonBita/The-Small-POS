// Salon follow-ups (founder, 21/10/2026): a walk-in service added from the
// ticket picker asks who does it, with "No stylist" as a choice; the line then
// carries `staff_id` and `metadata.staff_name` like an appointment line.
// Products and menu items never ask.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  list: vi.fn(),
}));
vi.mock('react-i18next', async original => ({ ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key) }) }));
vi.mock('../../../../../lib', async original => ({ ...(await original<typeof import('../../../../../lib')>()),
  isBrowser: () => false, getBridge: () => ({ staffSchedule: { list: state.list } }) }));
vi.mock('../../../../contexts/i18n-context', () => ({ useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: (key: string) => (key === 'common.actions.close' ? 'Close' : key) }) }));
vi.mock('../../../../hooks/useAcquiredModules', () => ({ useAcquiredModules: () => ({ hasModule: () => true }) }));
vi.mock('../../../../hooks/useServices', () => ({ useServices: () => ({ isLoading: false, services: [{ id: 'haircut', name: 'Haircut', price: 25, isActive: true, durationMinutes: 45, vatCategoryCode: 'gr_standard_24', priceIncludesVat: true }] }) }));
vi.mock('../../../../hooks/useProductCatalog', () => ({ useProductCatalog: () => ({ products: [{ id: 'shampoo', name: 'Shampoo', price: 8, isActive: true, vatCategoryCode: 'retail-vat' }] }) }));
vi.mock('../../../../hooks/useTerminalSettings', () => ({ useTerminalSettings: () => ({ getSetting: () => false }) }));
import { SalonCatalogPicker } from '../SalonCatalogPicker';
import { stylistsFromStaffPayload } from '../StylistPicker';

const MARIA = '5a1f0000-0000-4000-8000-000000000001';
const staffReply = (staff: unknown[]) => ({ success: true, data: { success: true, staff, shifts: [] }, meta: { source: 'cache' } });

// jsdom runs no CSS animations: end the glass modal's exit so it unmounts
// and gives the page back.
const finishLeavingModals = () => {
  document.querySelectorAll('.liquid-glass-modal-shell.leaving').forEach((shell) => {
    for (const type of ['animationend', 'webkitAnimationEnd', 'mozAnimationEnd']) {
      fireEvent(shell, new Event(type, { bubbles: true }));
    }
  });
};

beforeEach(() => {
  state.list.mockReset();
});
afterEach(cleanup);

describe('walk-in stylist in the salon ticket picker', () => {
  it('reads ids and names only from the branch staff list, without a date range', () => {
    expect(stylistsFromStaffPayload({ staff: [
      { id: MARIA, name: 'Maria', pin_hash: 'secret', has_pin: true, roles: [{ name: 'stylist' }] },
      { id: 'eleni', firstName: 'Eleni', lastName: 'K' },
      { id: '', name: 'No id' },
      { id: MARIA, name: 'Duplicate' },
    ] })).toEqual([{ id: MARIA, name: 'Maria' }, { id: 'eleni', name: 'Eleni K' }]);
    expect(stylistsFromStaffPayload(null)).toEqual([]);
  });

  it('asks who does the service and puts the stylist on the line', { timeout: 20000 }, async () => {
    state.list.mockResolvedValue(staffReply([{ id: MARIA, name: 'Maria' }, { id: 'eleni', name: 'Eleni' }]));
    const add = vi.fn();
    render(<SalonCatalogPicker branchId="branch" organizationId="org" search="" menuItems={[]} onAdd={add} />);
    await waitFor(() => expect(state.list).toHaveBeenCalledWith({ branch_id: 'branch' }));
    fireEvent.click(screen.getByRole('button', { name: /Haircut/ }));
    expect(add).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Maria' }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toMatchObject({ service_id: 'haircut', appointment_id: null, staff_id: MARIA,
      metadata: { staff_id: MARIA, staff_name: 'Maria' }, price: 25 });
  });

  it('adds the service without staff on "No stylist", and nothing on cancel', { timeout: 20000 }, async () => {
    state.list.mockResolvedValue(staffReply([{ id: MARIA, name: 'Maria' }]));
    const add = vi.fn();
    render(<SalonCatalogPicker branchId="branch" organizationId="org" search="" menuItems={[]} onAdd={add} />);
    await screen.findByRole('button', { name: /Haircut/ });
    await waitFor(() => expect(state.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Haircut/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    finishLeavingModals();
    expect(add).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Haircut/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'No stylist' }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toMatchObject({ service_id: 'haircut', staff_id: null,
      metadata: { staff_id: null, staff_name: null } });
  });

  it('never asks for products, and adds a service at once when the branch has no staff', async () => {
    state.list.mockRejectedValue(new Error('offline, no cache'));
    const add = vi.fn();
    render(<SalonCatalogPicker branchId="branch" organizationId="org" search="" menuItems={[]} onAdd={add} />);
    fireEvent.click(screen.getByRole('button', { name: /Shampoo/ }));
    expect(add).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(state.list).toHaveBeenCalled());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    fireEvent.click(screen.getByRole('button', { name: /Haircut/ }));
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1][0]).toMatchObject({ service_id: 'haircut', staff_id: null });
  });

  it('drops staff and a pending choice when the terminal changes organization or branch', async () => {
    state.list.mockResolvedValueOnce(staffReply([{ id: MARIA, name: 'Maria' }]))
      .mockResolvedValueOnce(staffReply([{ id: 'other-stylist', name: 'Lia' }]));
    const add = vi.fn();
    const view = render(<SalonCatalogPicker branchId="branch" organizationId="org" search="" menuItems={[]} onAdd={add} />);
    fireEvent.click(screen.getByRole('button', { name: /Haircut/ }));
    await screen.findByRole('button', { name: 'Maria' });
    view.rerender(<SalonCatalogPicker branchId="other-branch" organizationId="other-org" search="" menuItems={[]} onAdd={add} />);
    finishLeavingModals();
    await waitFor(() => expect(state.list).toHaveBeenLastCalledWith({ branch_id: 'other-branch' }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: /Haircut/ }));
    expect(screen.queryByRole('button', { name: 'Maria' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Lia' }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toMatchObject({ staff_id: 'other-stylist', metadata: { staff_name: 'Lia' } });
  });
});
