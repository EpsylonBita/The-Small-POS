import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ api: vi.fn(), save: vi.fn(), lookup: vi.fn(), hasPro: true, hasDelivery: true, t: (key: string, fallback?: string) => fallback || key,
  customer: { id: 'customer', name: 'Customer', phone: '+306900000000', created_at: '2026-09-01', addresses: [{ id: 'address', street_address: 'Old street 1', city: 'Old city', postal_code: '10000', floor_number: '2', is_default: true, latitude: 40.6, longitude: 22.9, coordinate_source: 'manual', place_id: 'saved-place' }] } }));
vi.mock('../../../lib', () => ({ getBridge: () => ({ customers: { search: async () => [state.customer], lookupById: state.lookup, updateAddress: state.save } }), onEvent: vi.fn(), offEvent: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('../../contexts/module-context', () => ({ useModuleAccess: (module: string) => ({ isEnabled: module === 'delivery' ? state.hasDelivery : state.hasPro }) }));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('../../utils/api-helpers', () => ({ posApiFetch: state.api, posApiGet: vi.fn() }));
vi.mock('../../utils/render-modal-portal', () => ({ renderModalPortal: (content: any) => content }));
vi.mock('framer-motion', () => ({ motion: { div: ({ children, initial, animate, exit, variants, ...props }: any) => <div {...props}>{children}</div>, tr: ({ children, initial, animate, exit, variants, ...props }: any) => <tr {...props}>{children}</tr> } }));
import UsersPage from '../UsersPage';

const pauseForSearch = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 380)); });
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (value: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const details = { success: true, data: { result: { place_id: 'google-place', geometry: { location: { lat: 37.9, lng: 23.7 } }, address_components: [{ long_name: 'Stale city', types: ['locality'] }, { long_name: '99999', types: ['postal_code'] }] } } };
async function openEditor() {
  const view = render(<UsersPage />);
  fireEvent.click(await screen.findByLabelText('users.viewDetails'));
  fireEvent.click(await screen.findByLabelText('customer.actions.editAddress'));
  return view;
}
async function beginDetails() {
  await openEditor();
  fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: 'New street' } });
  fireEvent.click(await screen.findByRole('button', { name: /Suggestion address/ }));
}

describe('customer directory address editing', () => {
  beforeEach(() => {
    state.api.mockReset(); state.save.mockReset(); state.lookup.mockReset();
    state.lookup.mockResolvedValue(state.customer); state.hasPro = true; state.hasDelivery = true;
    state.api.mockResolvedValue({ success: true, data: { predictions: [{ place_id: 'google-place', description: 'Suggestion address' }] } });
    state.save.mockResolvedValue({ success: true, data: { id: 'address', street_address: 'New street', city: 'Changed city', postal_code: '10000', latitude: null, longitude: null, google_place_id: null } });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it.each(['street', 'city', 'postal'])('keeps a newer %s edit when older place details resolve', async field => {
    let complete!: (response: any) => void;
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByLabelText('users.viewDetails')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('users.viewDetails'));
    await waitFor(() => expect(screen.getByLabelText('customer.actions.editAddress')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('customer.actions.editAddress'));
    fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: 'New street' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Suggestion address/ })).toBeTruthy());
    state.api.mockImplementationOnce(() => new Promise(resolve => {complete = resolve}));
    fireEvent.click(screen.getByRole('button', { name: /Suggestion address/ }));
    fireEvent.change(screen.getByDisplayValue(field === 'street' ? 'New street' : field === 'city' ? 'Old city' : '10000'), { target: { value: 'My newer value' } });
    await act(async () => {complete({ success: true, data: { result: { place_id: 'google-place', geometry: { location: { lat: 37.9, lng: 23.7 } }, address_components: [{ long_name: 'Stale city', types: ['locality'] }, { long_name: '99999', types: ['postal_code'] }] } } })});
    expect(screen.getByDisplayValue('My newer value')).toBeTruthy();
    expect(screen.queryByDisplayValue('Stale city')).toBeNull();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0][1].latitude).toBeUndefined();
    expect(state.save.mock.calls[0][1].longitude).toBeUndefined();
  });


  it.each([false, true])('uses saved suggestions without autocomplete or details (Pro=%s)', async hasPro => {
    state.hasPro = hasPro;
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: 'Old str' } });
    fireEvent.click(await screen.findByRole('button', { name: /Old street 1, Old city/ }));
    expect(state.api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0][0]).toBe('address');
    expect(state.save.mock.calls[0][1]).toMatchObject({ latitude: 40.6, longitude: 22.9, place_id: 'saved-place', floor_number: '2' });
  });

  it('requires both Delivery and Delivery Zones for external search', async () => {
    state.hasDelivery = false;
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: 'New street' } });
    await pauseForSearch();
    expect(state.api).not.toHaveBeenCalled();
  });

  it('keeps Basic manual entry free of provider calls when no saved row matches', async () => {
    state.hasPro = false;
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: 'New street' } });
    await pauseForSearch();
    expect(state.api).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Suggestion address/ })).toBeNull();
  });

  it('debounces 350ms and only searches the latest query without an Athens bias', async () => {
    await openEditor();
    vi.useFakeTimers();
    fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: 'New' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.change(screen.getByDisplayValue('New'), { target: { value: 'New street' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(349); });
    expect(state.api).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(state.api).toHaveBeenCalledTimes(1);
    const request = JSON.parse(state.api.mock.calls[0][1].body);
    expect(request.query).toBe('New street');
    expect(request.session_token).toBeTruthy();
    expect(request).not.toHaveProperty('location');
    expect(request).not.toHaveProperty('radius');
  });

  it('reuses autocomplete token for details, then starts a fresh interaction after a pick', async () => {
    const pending = deferred();
    state.api.mockImplementation((path: string) => path.endsWith('details') ? pending.promise : Promise.resolve({ success: true, data: { predictions: [{ place_id: 'google-place', description: 'Suggestion address' }] } }));
    await beginDetails();
    const firstSearch = JSON.parse(state.api.mock.calls[0][1].body);
    const pick = JSON.parse(state.api.mock.calls[1][1].body);
    expect(pick.session_token).toBe(firstSearch.session_token);
    fireEvent.change(screen.getByDisplayValue('New street'), { target: { value: 'Current street' } });
    await waitFor(() => expect(state.api).toHaveBeenCalledTimes(3));
    const newSearch = JSON.parse(state.api.mock.calls[2][1].body);
    expect(newSearch.session_token).toBeTruthy();
    expect(newSearch.session_token).not.toBe(firstSearch.session_token);
    await act(async () => { pending.resolve(details); });
    expect(screen.getByDisplayValue('Current street')).toBeTruthy();
  });

  it.each(['ab', '#Taxi'])('skips searches for short/special input %s', async query => {
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: query } });
    await pauseForSearch();
    expect(state.api).not.toHaveBeenCalled();
  });

  it('discards older autocomplete after a newer answer', async () => {
    const old = deferred(); const next = deferred();
    state.api.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: 'First street' } });
    await waitFor(() => expect(state.api).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByDisplayValue('First street'), { target: { value: 'Second street' } });
    await waitFor(() => expect(state.api).toHaveBeenCalledTimes(2));
    await act(async () => { next.resolve({ success: true, data: { predictions: [{ place_id: 'new', description: 'New answer' }] } }); });
    await act(async () => { old.resolve({ success: true, data: { predictions: [{ place_id: 'old', description: 'Old answer' }] } }); });
    expect(screen.getByRole('button', { name: /New answer/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Old answer/ })).toBeNull();
  });

  it('does not apply a failed details fallback over newer manual input', async () => {
    const pending = deferred();
    state.api.mockImplementation((path: string) => path.endsWith('details') ? pending.promise : Promise.resolve({ success: true, data: { predictions: [{ place_id: 'google-place', description: 'Suggestion address' }] } }));
    await beginDetails();
    fireEvent.change(screen.getByDisplayValue('New street'), { target: { value: 'Current street' } });
    await act(async () => { pending.reject(new Error('old request')); });
    expect(screen.getByDisplayValue('Current street')).toBeTruthy();
  });

  it('discards details across cancellation and a new edit', async () => {
    const pending = deferred();
    state.api.mockImplementation((path: string) => path.endsWith('details') ? pending.promise : Promise.resolve({ success: true, data: { predictions: [{ place_id: 'google-place', description: 'Suggestion address' }] } }));
    await beginDetails();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByLabelText('customer.actions.editAddress'));
    await act(async () => { pending.resolve(details); });
    expect(screen.getByDisplayValue('Old city')).toBeTruthy();
    expect(screen.queryByDisplayValue('Stale city')).toBeNull();
  });

  it('discards details after the module is revoked', async () => {
    const pending = deferred();
    state.api.mockImplementation((path: string) => path.endsWith('details') ? pending.promise : Promise.resolve({ success: true, data: { predictions: [{ place_id: 'google-place', description: 'Suggestion address' }] } }));
    const view = await openEditor();
    fireEvent.change(screen.getByDisplayValue('Old street 1'), { target: { value: 'New street' } });
    fireEvent.click(await screen.findByRole('button', { name: /Suggestion address/ }));
    state.hasPro = false;
    view.rerender(<UsersPage />);
    await act(async () => { pending.resolve(details); });
    expect(screen.getByDisplayValue('Old city')).toBeTruthy();
  });

  it('discards customer lookup after closing and reopening', async () => {
    const old = deferred();
    state.lookup.mockReturnValueOnce(old.promise).mockResolvedValueOnce(state.customer);
    render(<UsersPage />);
    fireEvent.click(await screen.findByLabelText('users.viewDetails'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('users.viewDetails'));
    await screen.findByLabelText('customer.actions.editAddress');
    await act(async () => { old.resolve({ ...state.customer, addresses: [{ ...state.customer.addresses[0], street_address: 'Stale customer address' }] }); });
    expect(screen.queryByText(/Stale customer address/)).toBeNull();
    expect(screen.getByText(/Old street 1, Old city/)).toBeTruthy();
  });

  it('never revives the old point after a manual address is saved then reopened', async () => {
    state.save.mockResolvedValue({ success: true });
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('Old city'), { target: { value: 'Current city' } });
    fireEvent.click(screen.getByText('Save'));
    await screen.findByLabelText('customer.actions.editAddress');
    fireEvent.click(screen.getByLabelText('customer.actions.editAddress'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(2));
    expect(state.save.mock.calls[1][1].latitude).toBeUndefined();
    expect(state.save.mock.calls[1][1].longitude).toBeUndefined();
    expect(state.save.mock.calls[1][1].place_id).toBeUndefined();
  });

  it('keeps a newer edit open after an older address write finishes', async () => {
    const pending = deferred();
    state.save.mockReturnValueOnce(pending.promise);
    await openEditor();
    fireEvent.click(screen.getByText('Save'));
    fireEvent.change(screen.getByDisplayValue('Old city'), { target: { value: 'Current city' } });
    await act(async () => { pending.resolve({ success: true, data: { version: 5 } }); });
    expect(screen.getByDisplayValue('Current city')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('does not close a reopened editor when the previous write finishes', async () => {
    const pending = deferred();
    state.save.mockReturnValueOnce(pending.promise);
    await openEditor();
    fireEvent.click(screen.getByText('Save'));
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByLabelText('customer.actions.editAddress'));
    await act(async () => { pending.resolve({ success: true, data: { version: 5 } }); });
    expect(screen.getByDisplayValue('Old city')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('drops invalid details geometry rather than storing a bogus point', async () => {
    state.api.mockImplementation((path: string) => Promise.resolve(path.endsWith('details') ? { success: true, data: { result: { place_id: 'place', geometry: { location: { lat: 0, lng: 0 } }, address_components: [] } } } : { success: true, data: { predictions: [{ place_id: 'google-place', description: 'Suggestion address' }] } }));
    await beginDetails();
    await waitFor(() => expect(screen.getByDisplayValue('Suggestion address')).toBeTruthy());
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0][1].latitude).toBeUndefined();
    expect(state.save.mock.calls[0][1].longitude).toBeUndefined();
    expect(state.save.mock.calls[0][1].coordinate_source).toBeUndefined();
  });
});
