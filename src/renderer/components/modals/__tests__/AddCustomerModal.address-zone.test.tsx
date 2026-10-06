import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Symptom (Tomikro desktop, founder report 29/09/2026): editing a saved
// address — only the floor or the bell name — answered «Address is outside
// delivery area». Root cause: about two thirds of the store's saved addresses
// have no coordinates, and `Number(null) === 0` turned them into the point
// (0,0), which the office correctly places out of zone. An address without a
// point is now "zone not checked" (pick it again), never out of zone, and full
// "Edit customer" finally saves its address changes (they were dropped).

const mock = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  updateCustomerAddress: vi.fn(),
  addCustomerAddress: vi.fn(),
  getSetting: vi.fn(),
  getBranchId: vi.fn(),
  validateAddressForDelivery: vi.fn(),
  searchAddressSuggestions: vi.fn(),
  resolveAddressSuggestion: vi.fn(),
  upsertVerifiedLocalCandidate: vi.fn(),
  bridge: null as any,
}));

vi.mock('../../../../lib', () => ({
  getBridge: () => mock.bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));
vi.mock('../../../services/CustomerService', () => ({
  customerService: {
    createCustomer: mock.createCustomer,
    updateCustomer: mock.updateCustomer,
    updateCustomerAddress: mock.updateCustomerAddress,
    addCustomerAddress: mock.addCustomerAddress,
  },
}));
vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('../../../hooks/useAcquiredModules', () => ({
  MODULE_IDS: { DELIVERY: 'delivery', DELIVERY_ZONES: 'delivery_zones' },
  // Delivery Pro: address search and zone validation are on.
  useAcquiredModules: () => ({ hasModule: () => true }),
}));
vi.mock('../../../services/terminal-credentials', () => ({
  getResolvedTerminalCredentials: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
}));
vi.mock('../../../services/address-workflow', () => ({
  buildAddressFingerprint: vi.fn((address: string) => `fp:${address}`),
  createAddressSessionToken: vi.fn(() => 'session'),
  ensureAddressOfflineRuntime: vi.fn(),
  extractStreetNumber: vi.fn(() => null),
  getSuggestionStreetLabel: vi.fn((suggestion: any) => suggestion?.main_text ?? ''),
  resolveAddressSuggestion: mock.resolveAddressSuggestion,
  searchAddressSuggestions: mock.searchAddressSuggestions,
  upsertVerifiedLocalCandidate: mock.upsertVerifiedLocalCandidate,
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
import { AddCustomerModal } from '../AddCustomerModal';

const ZONE = { id: 'zone-1', name: 'Zone 1', delivery_fee: 0, minimum_order_amount: 5 };
const inZone = (coordinates?: { lat: number; lng: number }) => ({
  success: true,
  isValid: true,
  deliveryAvailable: true,
  validation_status: 'in_zone',
  requires_override: false,
  house_number_match: true,
  selectedZone: ZONE,
  coordinates,
  address_fingerprint: 'fp-validated',
  validation_source: 'online',
});

// The shape CustomerSearchModal hands over for an address saved without a
// point: explicit nulls, and a (0,0) object built from them.
const uncoordinatedAddress = {
  id: 'addr-uncoordinated',
  street_address: 'Synthetic Street 12',
  city: 'Thessaloniki',
  postal_code: '54621',
  floor_number: '2',
  name_on_ringer: 'Synthetic',
  delivery_notes: 'Ring twice',
  latitude: null,
  longitude: null,
  coordinates: { lat: 0, lng: 0 },
  is_default: false,
  version: 5,
};
const coordinatedDefault = {
  id: 'addr-default',
  street_address: 'Synthetic Avenue 3',
  city: 'Thessaloniki',
  postal_code: '54622',
  floor_number: '1',
  name_on_ringer: 'Synthetic',
  delivery_notes: '',
  latitude: 40.6301,
  longitude: 22.9502,
  zone_id: 'stored-zone',
  validation_status: 'in_zone',
  address_fingerprint: 'stored-fingerprint',
  is_default: true,
  version: 2,
};
const customer = {
  id: 'c1d2e3f4-0000-4000-8000-000000000002',
  phone: '6948128474',
  phone_country_code: 'GR',
  name: 'Synthetic Customer',
  version: 7,
  addresses: [coordinatedDefault, uncoordinatedAddress],
};

const createI18n = async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  return instance;
};

const renderModal = async (props: Partial<React.ComponentProps<typeof AddCustomerModal>>) => {
  const i18n = await createI18n();
  const onCustomerAdded = vi.fn();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <AddCustomerModal isOpen onClose={() => {}} onCustomerAdded={onCustomerAdded} {...props} />
    </I18nextProvider>,
  );
  await act(async () => {});
  return { ...view, onCustomerAdded };
};

const submit = (container: HTMLElement) => fireEvent.submit(container.querySelector('form')!);

const everyValidationPoint = () =>
  mock.validateAddressForDelivery.mock.calls.map(([, options]) => options?.coordinates);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.getSetting.mockResolvedValue('GR');
  mock.getBranchId.mockResolvedValue('branch-1');
  mock.bridge = {
    terminalConfig: { getBranchId: mock.getBranchId, getSetting: mock.getSetting },
    customers: { invalidateCache: vi.fn(), lookupByPhone: vi.fn() },
  };
  mock.searchAddressSuggestions.mockResolvedValue([]);
  mock.upsertVerifiedLocalCandidate.mockResolvedValue(undefined);
  mock.validateAddressForDelivery.mockImplementation(async (_address: string, options: any) =>
    inZone(options?.coordinates),
  );
  mock.updateCustomer.mockImplementation(async (id: string, updates: any) => ({
    success: true,
    data: { id, name: updates.name, phone: customer.phone, version: 8 },
    code: null,
    status: null,
    conflict: false,
    queued: false,
    offline: false,
  }));
  mock.updateCustomerAddress.mockImplementation(async (id: string, patch: any) => ({
    success: true,
    data: { id, ...patch, version: 6 },
    customer: {
      id: customer.id,
      addresses: customer.addresses.map((address) => (address.id === id ? { ...address, ...patch, version: 6 } : address)),
    },
  }));
  mock.addCustomerAddress.mockImplementation(async (_customerId: string, address: any) => ({
    success: true,
    data: { id: 'addr-new', ...address },
  }));
  mock.createCustomer.mockImplementation(async (data: any) => ({
    success: true, data: { id: customer.id, ...data },
  }));
});

describe('selected coordinate persistence at every customer entry point', () => {
  it.each(['new', 'addAddress', 'editAddress', 'edit'] as const)('%s passes the exact newly selected point and its provenance', async mode => {
    const point = { lat: 40.6402, lng: 22.9441 };
    mock.searchAddressSuggestions.mockResolvedValue([
      { place_id: 'new-place', main_text: 'Synthetic New Street 8', secondary_text: 'Thessaloniki' },
    ]);
    mock.resolveAddressSuggestion.mockResolvedValue({
      streetAddress: 'Synthetic New Street 8', city: 'Thessaloniki', postalCode: '54622',
      coordinates: point, placeId: 'new-place', addressFingerprint: 'fp-new', validationSource: 'online',
    });
    const { container, onCustomerAdded } = await renderModal({
      mode,
      ...(mode === 'new' ? { initialPhone: customer.phone } : {
        initialCustomer: { ...customer, selected_address_id: coordinatedDefault.id, editAddressId: coordinatedDefault.id },
      }),
    });
    fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.streetPlaceholder), { target: { value: 'Synthetic New Street' } });
    fireEvent.click(await screen.findByText('Thessaloniki', { selector: 'p' }));
    await waitFor(() => expect(mock.validateAddressForDelivery).toHaveBeenCalled());
    if (mode === 'new') fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.namePlaceholder), { target: { value: customer.name } });
    fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.floorPlaceholder), { target: { value: '3' } });
    fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.nameOnRingerPlaceholder), { target: { value: 'Synthetic' } });
    submit(container);
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalledTimes(1));
    const write = mode === 'new' ? mock.createCustomer.mock.calls[0][0]
      : mode === 'addAddress' ? mock.addCustomerAddress.mock.calls[0][1]
      : mock.updateCustomerAddress.mock.calls[0][1];
    expect(write).toMatchObject({ coordinates: point, latitude: point.lat, longitude: point.lng });
    expect(mode === 'new' ? write.delivery_validation : write).toMatchObject({
      place_id: 'new-place', address_fingerprint: 'fp-validated', validation_status: 'in_zone', zone_id: 'zone-1',
    });
    const saved = onCustomerAdded.mock.calls[0][0];
    expect(saved.delivery_destination_unchanged).not.toBe(true);
    expect(saved.addresses.find((address: any) => address.street_address === 'Synthetic New Street 8')).toMatchObject({ latitude: point.lat, longitude: point.lng });
  });
});

describe('a saved address without coordinates', () => {
  it('opens as "zone not checked", never out of zone, and saves a floor change without checking (0,0)', async () => {
    const { container, onCustomerAdded } = await renderModal({
      mode: 'editAddress',
      initialCustomer: { ...customer, editAddressId: uncoordinatedAddress.id },
    });

    expect(screen.getByTestId('add-customer-zone-not-checked')).toHaveTextContent(en.modals.addCustomer.zoneNotChecked);
    expect(container.textContent).not.toContain(en.modals.addCustomer.addressOutsideArea);

    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '3' } });
    submit(container);

    await waitFor(() => expect(mock.updateCustomerAddress).toHaveBeenCalledTimes(1));
    // Regression: the unchanged street used to be zone-checked at (0,0).
    expect(mock.validateAddressForDelivery).not.toHaveBeenCalled();
    const [addressId, patch, version] = mock.updateCustomerAddress.mock.calls[0];
    expect(addressId).toBe(uncoordinatedAddress.id);
    expect(version).toBe(5);
    expect(patch).toMatchObject({
      street_address: 'Synthetic Street 12',
      floor_number: '3',
    });
    // Whatever point the office holds is left alone: no null, no (0,0).
    expect(patch).not.toHaveProperty('coordinates');
    expect(patch).not.toHaveProperty('latitude');
    expect(patch).not.toHaveProperty('longitude');
    expect(patch).not.toHaveProperty('zone_id');
    expect(patch).not.toHaveProperty('validation_status');
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalledWith(expect.objectContaining({
      selected_address_id: uncoordinatedAddress.id,
      editAddressId: uncoordinatedAddress.id,
    })));
  });

  it('"pick the address again" searches it with its city and saves the picked point', async () => {
    mock.searchAddressSuggestions.mockResolvedValue([
      { place_id: 'place-1', main_text: 'Synthetic Street 12', secondary_text: 'Thessaloniki', formatted_address: 'Synthetic Street 12, Thessaloniki' },
    ]);
    mock.resolveAddressSuggestion.mockResolvedValue({
      streetAddress: 'Synthetic Street 12',
      city: 'Thessaloniki',
      postalCode: '54621',
      coordinates: { lat: 40.6402, lng: 22.9441 },
      placeId: 'place-1',
      addressFingerprint: 'fp-picked',
      validationSource: 'online',
    });
    const { container, onCustomerAdded } = await renderModal({
      mode: 'editAddress',
      initialCustomer: { ...customer, editAddressId: uncoordinatedAddress.id },
    });

    fireEvent.click(screen.getByRole('button', { name: en.modals.addCustomer.repickAddress }));
    await waitFor(() => expect(mock.searchAddressSuggestions).toHaveBeenCalledWith(
      'Synthetic Street 12, Thessaloniki',
      expect.anything(),
    ));
    fireEvent.click(await screen.findByText('Thessaloniki', { selector: 'p' }));

    await waitFor(() => expect(mock.validateAddressForDelivery).toHaveBeenCalled());
    expect(everyValidationPoint()).toEqual([{ lat: 40.6402, lng: 22.9441 }]);
    await waitFor(() => expect(screen.queryByTestId('add-customer-zone-not-checked')).toBeNull());

    submit(container);
    await waitFor(() => expect(mock.updateCustomerAddress).toHaveBeenCalledTimes(1));
    expect(mock.updateCustomerAddress.mock.calls[0][1]).toMatchObject({
      coordinates: { lat: 40.6402, lng: 22.9441 },
      latitude: 40.6402,
      longitude: 22.9441,
      validation_status: 'in_zone',
      zone_id: 'zone-1',
    });
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalledWith(
      expect.objectContaining({ selected_address_id: uncoordinatedAddress.id }),
    ));
  });

  it('an offline candidate at (0,0) is "no coordinates", never a point to check', async () => {
    mock.searchAddressSuggestions.mockResolvedValue([
      { place_id: 'local-1', main_text: 'Synthetic Street 12', secondary_text: 'Thessaloniki', formatted_address: 'Synthetic Street 12' },
    ]);
    mock.resolveAddressSuggestion.mockResolvedValue({
      streetAddress: 'Synthetic Street 12',
      city: 'Thessaloniki',
      postalCode: '54621',
      coordinates: { lat: 0, lng: 0 },
      placeId: 'local-1',
      validationSource: 'offline_cache',
    });
    const { onCustomerAdded } = await renderModal({
      mode: 'editAddress',
      initialCustomer: { ...customer, editAddressId: uncoordinatedAddress.id },
    });

    fireEvent.click(screen.getByRole('button', { name: en.modals.addCustomer.repickAddress }));
    fireEvent.click(await screen.findByText('Thessaloniki', { selector: 'p' }));
    await waitFor(() => expect(mock.upsertVerifiedLocalCandidate).toHaveBeenCalled());
    expect(mock.upsertVerifiedLocalCandidate.mock.calls[0][0]).toMatchObject({ verified: false });
    expect(mock.upsertVerifiedLocalCandidate.mock.calls[0][0].location).toBeUndefined();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    for (const point of everyValidationPoint()) {
      expect(point).toBeUndefined();
    }
    expect(onCustomerAdded).not.toHaveBeenCalled();
  });
});

describe('full "Edit customer" saves address changes (founder, 29/09/2026)', () => {
  it('writes a changed floor without rechecking or replacing the selected address point and zone', async () => {
    mock.validateAddressForDelivery.mockRejectedValue(new Error('zone service offline'));
    const { container, onCustomerAdded } = await renderModal({
      mode: 'edit',
      initialCustomer: { ...customer, selected_address_id: coordinatedDefault.id },
    });
    expect(screen.queryByTestId('add-customer-zone-not-checked')).toBeNull();

    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '4' } });
    submit(container);

    await waitFor(() => expect(mock.updateCustomerAddress).toHaveBeenCalledTimes(1));
    expect(mock.validateAddressForDelivery).not.toHaveBeenCalled();
    expect(mock.updateCustomer).toHaveBeenCalledTimes(1);
    const [addressId, patch, version] = mock.updateCustomerAddress.mock.calls[0];
    expect(addressId).toBe(coordinatedDefault.id);
    expect(version).toBe(2);
    expect(patch).toMatchObject({
      street_address: 'Synthetic Avenue 3',
      floor_number: '4',
      customer_id: customer.id,
    });
    for (const key of ['coordinates', 'latitude', 'longitude', 'zone_id', 'validation_status', 'address_fingerprint']) {
      expect(patch).not.toHaveProperty(key);
      expect(mock.updateCustomer.mock.calls[0][1]).not.toHaveProperty(key);
    }
    expect(mock.updateCustomer.mock.calls[0][1]).not.toHaveProperty('delivery_validation');
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalledTimes(1));
    const handedOn = onCustomerAdded.mock.calls[0][0];
    expect(handedOn.delivery_destination_unchanged).toBe(true);
    expect(handedOn.selected_address_id).toBe(coordinatedDefault.id);
    expect(handedOn.addresses.find((address: any) => address.id === coordinatedDefault.id).floor_number).toBe('4');
    expect(handedOn.addresses.find((address: any) => address.id === coordinatedDefault.id)).toMatchObject({
      latitude: 40.6301, longitude: 22.9502, zone_id: 'stored-zone', address_fingerprint: 'stored-fingerprint',
    });
  });

  it('edits the selected address, not the default, when one is selected', async () => {
    const { container } = await renderModal({
      mode: 'edit',
      initialCustomer: { ...customer, selected_address_id: uncoordinatedAddress.id },
    });
    // The uncoordinated selected address opens unchecked, never out of zone.
    expect(screen.getByTestId('add-customer-zone-not-checked')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Synthetic'), { target: { value: 'Synthetic Family' } });
    submit(container);
    await waitFor(() => expect(mock.updateCustomerAddress).toHaveBeenCalledTimes(1));
    expect(mock.validateAddressForDelivery).not.toHaveBeenCalled();
    expect(mock.updateCustomerAddress.mock.calls[0][0]).toBe(uncoordinatedAddress.id);
    expect(mock.updateCustomerAddress.mock.calls[0][1]).toMatchObject({ name_on_ringer: 'Synthetic Family' });
    expect(mock.updateCustomerAddress.mock.calls[0][1]).not.toHaveProperty('coordinates');
  });

  it('does not write an address the cashier did not touch', async () => {
    const { container, onCustomerAdded } = await renderModal({ mode: 'edit', initialCustomer: customer });
    fireEvent.change(screen.getByDisplayValue('Synthetic Customer'), { target: { value: 'Synthetic Renamed' } });
    submit(container);
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalledTimes(1));
    expect(mock.updateCustomer).toHaveBeenCalledTimes(1);
    expect(mock.updateCustomerAddress).not.toHaveBeenCalled();
    expect(onCustomerAdded.mock.calls[0][0].selected_address_id).toBe(coordinatedDefault.id);
  });

  it('creates the default address for a customer who has none', async () => {
    const withoutAddresses = {
      ...customer,
      addresses: [],
      address: 'Synthetic Road 5',
      city: 'Thessaloniki',
      floor_number: '0',
      name_on_ringer: 'Synthetic',
    };
    const { container, onCustomerAdded } = await renderModal({ mode: 'edit', initialCustomer: withoutAddresses });
    fireEvent.change(screen.getByDisplayValue('0'), { target: { value: '5' } });
    submit(container);
    await waitFor(() => expect(mock.addCustomerAddress).toHaveBeenCalledTimes(1));
    expect(mock.addCustomerAddress.mock.calls[0][1]).toMatchObject({
      street_address: 'Synthetic Road 5',
      floor_number: '5',
      is_default: true,
    });
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalledWith(
      expect.objectContaining({ selected_address_id: 'addr-new' }),
    ));
  });

  // Review round: the notes box shows the edited address's delivery notes, so
  // a change belongs to that address. Writing it to the customer too replaced
  // a separate customer-level note.
  it('writes changed delivery notes to the address only and keeps the customer’s own note', async () => {
    const withNotes = {
      ...customer,
      notes: 'Synthetic customer note',
      addresses: [{ ...coordinatedDefault, delivery_notes: 'Leave at the door' }, uncoordinatedAddress],
    };
    const { container, onCustomerAdded } = await renderModal({ mode: 'edit', initialCustomer: withNotes });
    fireEvent.change(screen.getByDisplayValue('Leave at the door'), {
      target: { value: 'Leave at the door, bell 2' },
    });
    submit(container);
    await waitFor(() => expect(mock.updateCustomerAddress).toHaveBeenCalledTimes(1));
    expect(mock.updateCustomer).toHaveBeenCalledTimes(1);
    expect(mock.updateCustomer.mock.calls[0][1].notes).toBeUndefined();
    expect(mock.updateCustomerAddress.mock.calls[0][0]).toBe(coordinatedDefault.id);
    expect(mock.updateCustomerAddress.mock.calls[0][1]).toMatchObject({ notes: 'Leave at the door, bell 2' });
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalledTimes(1));
    expect(onCustomerAdded.mock.calls[0][0].notes).toBe('Synthetic customer note');
  });

  it('a customer with no saved address still keeps the notes on the customer', async () => {
    const withoutAddresses = {
      ...customer,
      addresses: [],
      address: 'Synthetic Road 5',
      city: 'Thessaloniki',
      floor_number: '0',
      name_on_ringer: 'Synthetic',
      notes: 'Synthetic customer note',
    };
    const { container } = await renderModal({ mode: 'edit', initialCustomer: withoutAddresses });
    fireEvent.change(screen.getByDisplayValue('Synthetic customer note'), {
      target: { value: 'Synthetic customer note, bell 2' },
    });
    submit(container);
    await waitFor(() => expect(mock.updateCustomer).toHaveBeenCalledTimes(1));
    expect(mock.updateCustomer.mock.calls[0][1].notes).toBe('Synthetic customer note, bell 2');
  });

  it('a genuine out-of-zone point keeps the desktop override flow', async () => {
    mock.searchAddressSuggestions.mockResolvedValue([
      { place_id: 'new-place', main_text: 'Synthetic New Street 8', secondary_text: 'Thessaloniki' },
    ]);
    mock.resolveAddressSuggestion.mockResolvedValue({
      streetAddress: 'Synthetic New Street 8', city: 'Thessaloniki', postalCode: '54622',
      coordinates: { lat: 40.7, lng: 23.1 }, placeId: 'new-place', addressFingerprint: 'fp-new',
      validationSource: 'online',
    });
    mock.validateAddressForDelivery.mockResolvedValue({
      ...inZone({ lat: 40.7, lng: 23.1 }),
      isValid: false,
      deliveryAvailable: false,
      validation_status: 'out_of_zone',
      requires_override: true,
      selectedZone: null,
    });
    const { container } = await renderModal({ mode: 'edit', initialCustomer: customer });
    fireEvent.change(screen.getByDisplayValue('Synthetic Avenue 3'), { target: { value: 'Synthetic New Street' } });
    fireEvent.click(await screen.findByText('Thessaloniki', { selector: 'p' }));
    await waitFor(() => expect(mock.validateAddressForDelivery).toHaveBeenCalled());
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(en.modals.addCustomer.outOfZoneOverrideRequired));
    expect(mock.updateCustomer).not.toHaveBeenCalled();
    expect(mock.updateCustomerAddress).not.toHaveBeenCalled();
  });
});
