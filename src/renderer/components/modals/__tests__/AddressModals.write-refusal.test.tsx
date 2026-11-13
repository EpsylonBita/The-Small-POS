import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Desktop 1.4.119 (rel-desktop-rust): the native address commands answer a
// refused write with Ok({success:false, code, status, error}), `error` being
// the bare machine code. AddNewAddressModal showed it raw («Failed to add new
// address: INVALID_COORDINATES») and so did EditAddressModal («Failed to
// update address: NOT_FOUND»). Both now name the refusal in the cashier's
// language, keep the form open and never report the address as saved.

const mock = vi.hoisted(() => ({
  addAddress: vi.fn(),
  updateAddress: vi.fn(),
  deliveryPro: false,
  locateTypedAddress: vi.fn(),
  searchAddressSuggestions: vi.fn(),
  resolveAddressSuggestion: vi.fn(),
  validateAddressForDelivery: vi.fn(),
}));

vi.mock('../../../../lib', () => ({
  getBridge: () => ({
    customers: { addAddress: mock.addAddress, updateAddress: mock.updateAddress },
  }),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));
vi.mock('../../../hooks/useAcquiredModules', () => ({
  MODULE_IDS: { DELIVERY: 'delivery', DELIVERY_ZONES: 'delivery_zones' },
  useAcquiredModules: () => ({ hasModule: () => mock.deliveryPro }),
}));
vi.mock('../../../services/terminal-credentials', () => ({
  getResolvedTerminalCredentials: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
}));
vi.mock('../../../services/address-workflow', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../services/address-workflow')>(),
  buildAddressFingerprint: vi.fn(() => 'fingerprint'),
  createAddressSessionToken: vi.fn(() => 'session'),
  ensureAddressOfflineRuntime: vi.fn(),
  locateTypedAddress: mock.locateTypedAddress,
  getSuggestionStreetLabel: (suggestion: any) => suggestion.main_text || '',
  resolveAddressSuggestion: mock.resolveAddressSuggestion,
  searchAddressSuggestions: mock.searchAddressSuggestions,
  upsertVerifiedLocalCandidate: vi.fn(),
  validateAddressForDelivery: mock.validateAddressForDelivery,
}));
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ children, isOpen }: any) => (isOpen ? <div>{children}</div> : null),
}));
vi.mock('../../forms/FloorPresetPicker', () => ({
  FloorPresetPicker: ({ value, onChange, placeholder }: any) => (
    <input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import en from '../../../../locales/en.json';
import el from '../../../../locales/el.json';
import { AddNewAddressModal } from '../AddNewAddressModal';
import EditAddressModal from '../EditAddressModal';

const createI18n = async (lng: 'en' | 'el' = 'en') => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: { en: { translation: en }, el: { translation: el } },
    interpolation: { escapeValue: false },
  });
  return instance;
};

const refusal = (code: string, status: number | null = 400, conflict = false) => ({
  success: false,
  code,
  errorCode: code,
  status,
  error: code,
  ...(conflict ? { conflict: true } : {}),
});

// Synthetic data only.
const customer = { id: 'c0ffee00-0000-4000-8000-000000000007', phone: '6900000001', name: 'Synthetic Customer' };
const address = {
  id: 'addr-1',
  street_address: 'Synthetic Street 3',
  city: 'Synthetic City',
  postal_code: '11111',
  floor_number: '2',
  notes: '',
  address_type: 'delivery',
  is_default: true,
  created_at: '2026-01-01T00:00:00.000Z',
};

let alertSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.clearAllMocks();
  mock.deliveryPro = false;
  mock.searchAddressSuggestions.mockReset().mockResolvedValue([]);
  mock.locateTypedAddress.mockReset().mockResolvedValue({ located: false, reason: 'not_found' });
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
});

describe('AddNewAddressModal', () => {
  const renderModal = async (lng: 'en' | 'el' = 'en') => {
    const i18n = await createI18n(lng);
    const onAddressAdded = vi.fn();
    const onClose = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <AddNewAddressModal isOpen onClose={onClose} customer={customer} onAddressAdded={onAddressAdded} />
      </I18nextProvider>,
    );
    await act(async () => {});
    const locale = lng === 'el' ? el : en;
    fireEvent.change(screen.getByPlaceholderText(locale.modals.addNewAddress.manualAddressPlaceholder), {
      target: { value: 'Synthetic Street 9' },
    });
    const submit = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: locale.modals.addNewAddress.addAddress }));
      });
    };
    return { onAddressAdded, onClose, submit };
  };

  it.each([
    ['INVALID_COORDINATES', 400, en.modals.addCustomer.addressLocationRejected],
    // An add goes through the customer: a 404 means the customer is gone.
    ['NOT_FOUND', 404, en.modals.addCustomer.customerNotFound],
    ['CUSTOMER_NOT_SYNCED', null, en.modals.addCustomer.customerNotSynced],
    ['CUSTOMER_SYNC_IN_PROGRESS', null, en.modals.addCustomer.customerSyncInProgress],
    ['HTTP_422', 422, 'The office did not accept the change (code HTTP_422). Check the details and try again.'],
  ])('a %s refusal is named, never shown raw, and nothing is added', async (code, status, text) => {
    mock.addAddress.mockResolvedValue(refusal(code, status));
    const { onAddressAdded, onClose, submit } = await renderModal();
    await submit();

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(text));
    expect(alertSpy).not.toHaveBeenCalledWith(expect.stringContaining(`: ${code}`));
    expect(onAddressAdded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('speaks the cashier’s language', async () => {
    mock.addAddress.mockResolvedValue(refusal('INVALID_COORDINATES'));
    const { submit } = await renderModal('el');
    await submit();
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(el.modals.addCustomer.addressLocationRejected));
  });

  it('a native failure shows the generic message, not its raw text', async () => {
    mock.addAddress.mockRejectedValue(new Error('Missing address street'));
    const { onAddressAdded, submit } = await renderModal();
    await submit();
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(en.modals.addCustomer.addressSaveFailed));
    expect(alertSpy).not.toHaveBeenCalledWith(expect.stringContaining('Missing address street'));
    expect(onAddressAdded).not.toHaveBeenCalled();
  });

  it('an address queued on this register (office unreachable) is added', async () => {
    mock.addAddress.mockResolvedValue({
      success: true,
      queued: true,
      offline: true,
      warning: 'CUSTOMER_ADDRESS_SAVED_OFFLINE',
      data: { id: 'local-addr-1', street_address: 'Synthetic Street 9' },
    });
    const { onAddressAdded, onClose, submit } = await renderModal();
    await submit();
    await waitFor(() => expect(onAddressAdded).toHaveBeenCalledWith(
      customer,
      'Synthetic Street 9',
      undefined,
      undefined,
      undefined,
    ));
    expect(onClose).toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('EditAddressModal', () => {
  const renderModal = async () => {
    const i18n = await createI18n();
    const onAddressUpdated = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <I18nextProvider i18n={i18n}>
        <EditAddressModal
          isOpen
          onClose={onClose}
          address={address}
          customerId={customer.id}
          onAddressUpdated={onAddressUpdated}
        />
      </I18nextProvider>,
    );
    await act(async () => {});
    const submit = async () => {
      await act(async () => {
        fireEvent.submit(view.container.querySelector('form')!);
      });
    };
    return { onAddressUpdated, onClose, submit };
  };

  it.each([
    ['NOT_FOUND', 404, false, en.modals.addCustomer.addressNotFound],
    ['VERSION_MISMATCH', 409, true, en.modals.addCustomer.conflictError],
    ['INVALID_COORDINATES', 400, false, en.modals.addCustomer.addressLocationRejected],
    ['CUSTOMER_NOT_SYNCED', null, false, en.modals.addCustomer.customerNotSynced],
    ['HTTP_400', 400, false, 'The office did not accept the change (code HTTP_400). Check the details and try again.'],
  ])('a %s refusal is named, never shown raw, and nothing is updated', async (code, status, conflict, text) => {
    mock.updateAddress.mockResolvedValue(refusal(code, status, conflict));
    const { onAddressUpdated, onClose, submit } = await renderModal();
    await submit();

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(text));
    expect(alertSpy).not.toHaveBeenCalledWith(expect.stringContaining(`: ${code}`));
    expect(onAddressUpdated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a native failure shows its own generic message, not the raw text', async () => {
    mock.updateAddress.mockRejectedValue(new Error('Customer/address not found'));
    const { onAddressUpdated, submit } = await renderModal();
    await submit();
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(en.modals.editAddress.updateError));
    expect(onAddressUpdated).not.toHaveBeenCalled();
  });

  it('a saved or queued update hands the address on and closes', async () => {
    const saved = { ...address, floor_number: '3' };
    mock.updateAddress.mockResolvedValue({
      success: true,
      queued: true,
      offline: true,
      warning: 'CUSTOMER_ADDRESS_SAVED_OFFLINE',
      data: saved,
    });
    const { onAddressUpdated, onClose, submit } = await renderModal();
    await submit();
    await waitFor(() => expect(onAddressUpdated).toHaveBeenCalledWith(saved));
    expect(onClose).toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});


describe('AddNewAddressModal map street name note', () => {
  it.each(['pick', 'typed'] as const)('shows a different route after %s, clears on edit, and hides a matching route', async source => {
    mock.deliveryPro = true;
    const street = 'Κωνσταντινουπόλεως 62';
    const route = 'Γιάννη Χαλκίδη';
    const note = `The map calls this street "${route}". Check that it is the right one.`;
    const details = { streetAddress: street, route, city: 'City', postalCode: '54249',
      coordinates: { lat: 40.614, lng: 22.9603 }, addressFingerprint: 'fp-note', validationSource: 'online' };
    mock.searchAddressSuggestions.mockResolvedValue([{ place_id: 'pick', main_text: street, secondary_text: 'City' }]);
    mock.resolveAddressSuggestion.mockResolvedValue(details);
    mock.locateTypedAddress.mockResolvedValue({ located: true, details });
    mock.validateAddressForDelivery.mockResolvedValue({ validation_status: 'in_zone' });
    const i18n = await createI18n();
    render(<I18nextProvider i18n={i18n}><AddNewAddressModal isOpen customer={customer} onClose={vi.fn()} onAddressAdded={vi.fn()} /></I18nextProvider>);
    const input = screen.getByPlaceholderText(en.modals.addNewAddress.addressPlaceholder);
    fireEvent.change(input, { target: { value: street } });
    if (source === 'pick') fireEvent.click(await screen.findByText('City'));
    else fireEvent.change(screen.getByPlaceholderText(en.modals.addNewAddress.postalPlaceholder), { target: { value: '54640' } });
    const line = await screen.findByText(note);
    expect(line).toHaveClass('text-xs', 'liquid-glass-modal-text-muted');
    expect(input).toHaveValue(street);
    fireEvent.change(input, { target: { value: `${street}A` } });
    expect(screen.queryByText(note)).toBeNull();
    mock.resolveAddressSuggestion.mockResolvedValue({ ...details, route: 'Κωνσταντινουπόλεως' });
    fireEvent.click(await screen.findByText('City'));
    await waitFor(() => expect(mock.resolveAddressSuggestion).toHaveBeenCalledTimes(source === 'pick' ? 2 : 1));
    await waitFor(() => expect(input).toHaveValue(street));
    expect(screen.queryByText(/The map calls this street/)).toBeNull();
  });
});

describe('AddNewAddressModal typed postal correction', () => {
  const point = { lat: 40.614, lng: 22.9603 };
  const located = { located: true, postalCodeDiffers: true, providerPostalCode: '54249', details: {
    streetAddress: 'Street 62', city: 'Map City', postalCode: '54249', coordinates: point, placeId: 'typed-place',
    resolvedStreetNumber: '62', addressFingerprint: 'fingerprint', validationSource: 'online',
  } };
  const setup = async () => {
    mock.deliveryPro = true;
    mock.searchAddressSuggestions.mockResolvedValue([{ place_id: 'pick', main_text: 'Street 62', secondary_text: 'City', distance_meters: 80 }]);
    mock.resolveAddressSuggestion.mockResolvedValue({ ...located.details, city: 'Typed City', placeId: 'pick' });
    mock.locateTypedAddress.mockResolvedValue(located);
    mock.validateAddressForDelivery.mockImplementation(async (_address: string, options: any) => ({ success: true, isValid: true,
      validation_status: 'in_zone', deliveryAvailable: true, coordinates: options.coordinates, address_fingerprint: 'fingerprint' }));
    mock.addAddress.mockResolvedValue({ success: true, data: {} });
    const i18n = await createI18n();
    const onClose = vi.fn();
    const onAddressAdded = vi.fn();
    const view = render(<I18nextProvider i18n={i18n}><AddNewAddressModal isOpen customer={customer} onClose={onClose} onAddressAdded={onAddressAdded} /></I18nextProvider>);
    fireEvent.change(screen.getByPlaceholderText(en.modals.addNewAddress.addressPlaceholder), { target: { value: 'Street 62' } });
    fireEvent.click(await screen.findByText(/City.*80 m/));
    await waitFor(() => expect(mock.validateAddressForDelivery).toHaveBeenCalledTimes(1));
    mock.validateAddressForDelivery.mockClear();
    return { ...view, i18n, onClose, onAddressAdded };
  };
  const postal = () => screen.getByPlaceholderText(en.modals.addNewAddress.postalPlaceholder);

  it('locates once after debounce, preserves typed postal code, shows note and saves point/place/number', async () => {
    const { onAddressAdded } = await setup();
    vi.useFakeTimers();
    fireEvent.change(postal(), { target: { value: '546 4' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    fireEvent.change(postal(), { target: { value: '546 40' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(699); });
    expect(mock.locateTypedAddress).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    vi.useRealTimers();
    expect(mock.locateTypedAddress).toHaveBeenCalledTimes(1);
    expect(mock.locateTypedAddress).toHaveBeenCalledWith({ street: 'Street 62', city: 'Typed City', postalCode: '546 40' }, { branchId: 'branch-1' });
    expect(postal()).toHaveValue('546 40');
    expect(screen.getByText('The map gives postal code 54249 for this address.')).toBeInTheDocument();
    expect(screen.getByText(en.modals.addCustomer.deliveryAvailable)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.modals.addNewAddress.addAddress }));
    await waitFor(() => expect(onAddressAdded).toHaveBeenCalledTimes(1));
    expect(mock.addAddress).toHaveBeenCalledWith(customer.id, expect.objectContaining({ postal_code: '546 40',
      coordinates: point, place_id: 'typed-place', resolved_street_number: '62', address_fingerprint: 'fingerprint' }));
    expect(mock.locateTypedAddress).toHaveBeenCalledTimes(1);
  });

  it('drops a typed-location zone verdict after a later street edit', async () => {
    await setup();
    let finish!: (value: any) => void;
    mock.validateAddressForDelivery.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    fireEvent.change(postal(), { target: { value: '546 40' } });
    await waitFor(() => expect(mock.validateAddressForDelivery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText(en.modals.addNewAddress.addressPlaceholder), { target: { value: 'Later Street 80' } });
    await act(async () => { finish({ success: true, isValid: true, validation_status: 'in_zone', coordinates: point }); });
    expect(screen.queryByText(en.modals.addCustomer.deliveryAvailable)).toBeNull();
    expect(screen.getByText(en.modals.addCustomer.selectAddressForValidation)).toBeInTheDocument();
  });

  it('uses the normal out-of-zone save refusal after a typed correction', async () => {
    const { onAddressAdded } = await setup();
    mock.validateAddressForDelivery.mockResolvedValue({ success: true, isValid: false, deliveryAvailable: false,
      validation_status: 'out_of_zone', requires_override: true });
    fireEvent.change(postal(), { target: { value: '546 40' } });
    await waitFor(() => expect(mock.validateAddressForDelivery).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(en.modals.addCustomer.validatingAddress)).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: en.modals.addNewAddress.addAddress }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(en.modals.addCustomer.outOfZoneOverrideRequired));
    expect(onAddressAdded).not.toHaveBeenCalled();
    expect(mock.addAddress).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'error', 'offline', 'no_number'])('keeps requires_selection for %s', async (kind) => {
    await setup();
    mock.locateTypedAddress.mockResolvedValue({ located: false, reason: 'imprecise' });
    if (kind === 'error') mock.locateTypedAddress.mockRejectedValue(new Error('old server'));
    if (kind === 'offline') vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    if (kind === 'no_number') fireEvent.change(screen.getByPlaceholderText(en.modals.addNewAddress.addressPlaceholder), { target: { value: 'Street Only' } });
    vi.useFakeTimers();
    fireEvent.change(postal(), { target: { value: '546 40' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    vi.useRealTimers();
    expect(screen.getByText(en.modals.addCustomer.selectAddressForValidation)).toBeInTheDocument();
    expect(mock.validateAddressForDelivery).not.toHaveBeenCalled();
    if (kind === 'offline' || kind === 'no_number') expect(mock.locateTypedAddress).not.toHaveBeenCalled();
  });

  it.each(['street', 'postal', 'pick', 'cancel', 'close', 'customer', 'module', 'unmount'])('ignores pending answer after %s', async (kind) => {
    const view = await setup();
    let finish!: (value: any) => void;
    mock.locateTypedAddress.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    fireEvent.change(postal(), { target: { value: '546 40' } });
    await waitFor(() => expect(mock.locateTypedAddress).toHaveBeenCalledTimes(1));
    expect(screen.getByText(en.modals.addCustomer.validatingAddress)).toBeInTheDocument();
    if (kind === 'street' || kind === 'pick') {
      fireEvent.change(screen.getByPlaceholderText(en.modals.addNewAddress.addressPlaceholder), { target: { value: 'Later Street 80' } });
      if (kind === 'pick') {
        fireEvent.click(await screen.findByText(/City.*80 m/));
        await waitFor(() => expect(mock.validateAddressForDelivery).toHaveBeenCalledTimes(1));
      }
    } else if (kind === 'postal') fireEvent.change(postal(), { target: { value: '546 41' } });
    else if (kind === 'cancel') fireEvent.click(screen.getByRole('button', { name: en.modals.addNewAddress.cancel }));
    else if (kind === 'unmount') view.unmount();
    else {
      if (kind === 'module') mock.deliveryPro = false;
      view.rerender(<I18nextProvider i18n={view.i18n}><AddNewAddressModal isOpen={kind !== 'close'} customer={kind === 'customer' ? { ...customer, id: 'other' } : customer} onClose={view.onClose} onAddressAdded={view.onAddressAdded} /></I18nextProvider>);
    }
    await act(async () => { finish(located); });
    expect(screen.queryByText('The map gives postal code 54249 for this address.')).toBeNull();
    expect(mock.validateAddressForDelivery.mock.calls.some(([, options]) => options.placeId === 'typed-place')).toBe(false);
  });
});


it('AddNewAddressModal retains its selected city across successive completed postal corrections', async () => {
  mock.deliveryPro = true;
  mock.searchAddressSuggestions.mockResolvedValue([{ place_id: 'pick', main_text: 'Street 62', secondary_text: 'City' }]);
  const details = { streetAddress: 'Street 62', city: 'Original City', postalCode: '11111', coordinates: { lat: 40.614, lng: 22.9603 }, addressFingerprint: 'fingerprint' };
  mock.resolveAddressSuggestion.mockResolvedValue(details);
  mock.locateTypedAddress.mockResolvedValue({ located: true, details: { ...details, city: 'Map City' } });
  mock.validateAddressForDelivery.mockResolvedValue({ success: true, isValid: true, deliveryAvailable: true, validation_status: 'in_zone' });
  const i18n = await createI18n();
  render(<I18nextProvider i18n={i18n}><AddNewAddressModal isOpen customer={customer} onClose={vi.fn()} onAddressAdded={vi.fn()} /></I18nextProvider>);
  fireEvent.change(screen.getByPlaceholderText(en.modals.addNewAddress.addressPlaceholder), { target: { value: 'Street 62' } });
  fireEvent.click(await screen.findByText('City', { selector: 'p' }));
  await waitFor(() => expect(mock.validateAddressForDelivery).toHaveBeenCalledTimes(1));
  for (const postalCode of ['54640', '54641']) {
    fireEvent.change(screen.getByPlaceholderText(en.modals.addNewAddress.postalPlaceholder), { target: { value: postalCode } });
    await waitFor(() => expect(mock.locateTypedAddress).toHaveBeenCalledWith({ street: 'Street 62', city: 'Original City', postalCode }, expect.anything()));
    await waitFor(() => expect(screen.getByText(en.modals.addCustomer.deliveryAvailable)).toBeInTheDocument());
  }
});
