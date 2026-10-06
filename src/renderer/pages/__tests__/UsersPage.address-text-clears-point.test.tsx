import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Desktop 1.4.124 (fix 6): an address TEXT edit saved offline kept its old map
// pin. Symptom: the cashier corrected a customer's street on the Customers
// page while the office was unreachable; the next delivery order for that
// address was zoned and priced from the previous location. Root cause: a
// street/city/postal edit left latitude/longitude/place_id `undefined`, which
// the IPC JSON drops, so the native save read "point unchanged" and its
// offline merge kept the stored point and place id. A changed destination now
// sends explicit nulls (a clear); an unchanged destination still omits them.

const state = vi.hoisted(() => ({
  api: vi.fn(),
  save: vi.fn(),
  lookup: vi.fn(),
  t: (key: string, fallback?: string) => fallback || key,
  customer: {
    id: 'customer',
    name: 'Customer',
    phone: '+306900000000',
    created_at: '2026-09-01',
    addresses: [] as any[],
  },
}));
vi.mock('../../../lib', () => ({
  getBridge: () => ({
    customers: { search: async () => [state.customer], lookupById: state.lookup, updateAddress: state.save },
  }),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('../../contexts/module-context', () => ({ useModuleAccess: () => ({ isEnabled: true }) }));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('../../utils/api-helpers', () => ({ posApiFetch: state.api, posApiGet: vi.fn() }));
vi.mock('../../utils/render-modal-portal', () => ({ renderModalPortal: (content: any) => content }));
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, initial, animate, exit, variants, ...props }: any) => <div {...props}>{children}</div>,
    tr: ({ children, initial, animate, exit, variants, ...props }: any) => <tr {...props}>{children}</tr>,
  },
}));
import UsersPage from '../UsersPage';

// Synthetic data only. A Google-sourced point needs a fresh geocode to count.
const located = {
  id: 'address',
  street_address: 'Old street 1',
  city: 'Old city',
  postal_code: '10000',
  floor_number: '2',
  is_default: true,
  latitude: 40.6,
  longitude: 22.9,
  coordinate_source: 'manual',
  place_id: 'saved-place',
  version: 4,
};
const unlocated = {
  id: 'other',
  street_address: 'Other street 9',
  city: 'Other city',
  postal_code: '20000',
  floor_number: '7',
  is_default: false,
  version: 2,
};

/** What the IPC actually carries: `undefined` keys vanish, `null` stays. */
const wire = (payload: unknown) => JSON.parse(JSON.stringify(payload));

async function openEditor(addressId: 'address' | 'other' = 'address') {
  render(<UsersPage />);
  fireEvent.click(await screen.findByLabelText('users.viewDetails'));
  const editButtons = await screen.findAllByLabelText('customer.actions.editAddress');
  expect(editButtons).toHaveLength(state.customer.addresses.length);
  fireEvent.click(editButtons[state.customer.addresses.findIndex(address => address.id === addressId)]);
}

async function savedPayload(call = 0) {
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(call + 1));
  return state.save.mock.calls[call][1];
}

describe('Customers page: a changed destination clears its stored point', () => {
  beforeEach(() => {
    state.api.mockReset();
    state.save.mockReset();
    state.lookup.mockReset();
    state.customer.addresses = [located, unlocated];
    state.lookup.mockImplementation(async () => state.customer);
    state.api.mockResolvedValue({ success: true, data: { predictions: [] } });
    // The register's answer to a write the office has not seen yet.
    state.save.mockImplementation(async (id: string, payload: any) => ({
      success: true,
      queued: true,
      offline: true,
      data: { ...payload, id, coordinates: null, google_place_id: payload.place_id ?? null },
    }));
  });
  afterEach(() => cleanup());

  it.each([
    ['street', 'Old street 1', 'New street 7'],
    ['city', 'Old city', 'New city'],
    ['postal code', '10000', '10001'],
  ])('a %s edit sends an explicit clear of the point and place id', async (_field, from, to) => {
    await openEditor();
    fireEvent.change(screen.getByDisplayValue(from), { target: { value: to } });

    const sent = wire(await savedPayload());

    expect(sent).toHaveProperty('latitude', null);
    expect(sent).toHaveProperty('longitude', null);
    expect(sent).toHaveProperty('place_id', null);
    expect(sent.address_fingerprint).not.toMatch(/\|/);
  });

  it('picking another saved address without a point clears the edited one', async () => {
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: 'Other' } });
    fireEvent.click(await screen.findByRole('button', { name: /Other street 9, Other city/ }));
    expect(state.api).not.toHaveBeenCalled();

    const sent = wire(await savedPayload());

    expect(sent).toMatchObject({ street_address: 'Other street 9', city: 'Other city', postal_code: '20000' });
    expect(sent).toHaveProperty('latitude', null);
    expect(sent).toHaveProperty('longitude', null);
    expect(sent).toHaveProperty('place_id', null);
  });

  it('an instruction-only edit keeps the known point and place id', async () => {
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '5' } });

    const sent = wire(await savedPayload());

    expect(sent).toMatchObject({ floor_number: '5', latitude: 40.6, longitude: 22.9, place_id: 'saved-place' });
  });

  it('an instruction-only edit of an unlocated address omits the point instead of clearing it', async () => {
    await openEditor('other');
    fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '8' } });

    const sent = wire(await savedPayload());

    expect(sent.floor_number).toBe('8');

    for (const key of ['latitude', 'longitude', 'place_id']) {
      expect(sent).not.toHaveProperty(key);
    }
  });

  it('typing the original destination back keeps the stored point (no clear)', async () => {
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: 'Old street 12' } });
    fireEvent.change(screen.getByDisplayValue('Old street 12'), { target: { value: 'Old street 1' } });

    const sent = wire(await savedPayload());

    for (const key of ['latitude', 'longitude', 'place_id']) {
      expect(sent).not.toHaveProperty(key);
    }
  });

  it('after a queued text edit, reopening and saving never sends the old point back', async () => {
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('Old city'), { target: { value: 'New city' } });
    expect(wire(await savedPayload())).toHaveProperty('latitude', null);

    await screen.findByText(/Old street 1, New city/);
    fireEvent.click(screen.getAllByLabelText('customer.actions.editAddress')[0]);
    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '3' } });
    const second = wire(await savedPayload(1));

    expect(second.floor_number).toBe('3');
    for (const key of ['latitude', 'longitude', 'place_id']) {
      expect(second).not.toHaveProperty(key);
    }
  });
});
