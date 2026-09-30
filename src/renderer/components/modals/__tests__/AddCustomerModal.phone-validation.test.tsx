import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Incident 2026-09-28 (Tomikro, desktop 1.4.118): symptom — the Z report
// refused with «Cannot close day: pre-Z-report sync failed:
// PARITY_SYNC_PARTIAL». Root cause — this form only checked that the phone
// was not empty, so an 11-digit mobile reached the office, which refused it
// (400 INVALID_PHONE), and the till queued the customer anyway. These tests
// pin the form side: the field turns red with the store country's rule, a
// refused write is shown on the form and never accepted as a customer.

const mock = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  updateCustomerAddress: vi.fn(),
  addCustomerAddress: vi.fn(),
  getSetting: vi.fn(),
  getBranchId: vi.fn(),
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
vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../../hooks/useAcquiredModules', () => ({
  MODULE_IDS: { DELIVERY: 'delivery', DELIVERY_ZONES: 'delivery_zones' },
  useAcquiredModules: () => ({ hasModule: () => false }),
}));
vi.mock('../../../services/terminal-credentials', () => ({
  getResolvedTerminalCredentials: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
}));
vi.mock('../../../services/address-workflow', () => ({
  buildAddressFingerprint: vi.fn(() => 'fingerprint'),
  createAddressSessionToken: vi.fn(() => 'session'),
  ensureAddressOfflineRuntime: vi.fn(),
  extractStreetNumber: vi.fn(() => null),
  getSuggestionStreetLabel: vi.fn(() => ''),
  resolveAddressSuggestion: vi.fn(),
  searchAddressSuggestions: vi.fn().mockResolvedValue([]),
  upsertVerifiedLocalCandidate: vi.fn(),
  validateAddressForDelivery: vi.fn(),
}));
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ children, isOpen, header }: any) => (isOpen ? <div>{header}{children}</div> : null),
}));
vi.mock('../../forms/FloorPresetPicker', () => ({
  FloorPresetPicker: ({ value, onChange, placeholder }: any) => (
    <input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import en from '../../../../locales/en.json';
import el from '../../../../locales/el.json';
import {
  CUSTOMER_PHONE_TYPING_PARITY_CASES,
} from '../../../../../../shared/services/phone-input-validation.parity-cases';
import { AddCustomerModal } from '../AddCustomerModal';

const createI18n = async (lng: 'en' | 'el') => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: { en: { translation: en }, el: { translation: el } },
    interpolation: { escapeValue: false },
  });
  return instance;
};

const createdCustomer = {
  id: '4f0c8d9e-2f7a-4d0b-9a55-0e7f2b3c1a10',
  name: 'Synthetic Customer',
  phone: '6948128474',
  version: 1,
  addresses: [],
};

const rejection = (code: string, status = 400, conflict = false) => ({
  success: false,
  code,
  status,
  conflict,
  queued: false,
  offline: false,
  error: code,
});

const renderModal = async (
  props: Partial<React.ComponentProps<typeof AddCustomerModal>> = {},
  lng: 'en' | 'el' = 'en',
) => {
  const i18n = await createI18n(lng);
  const onCustomerAdded = vi.fn();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <AddCustomerModal isOpen onClose={() => {}} onCustomerAdded={onCustomerAdded} {...props} />
    </I18nextProvider>,
  );
  // Let the store country load from the terminal settings.
  await act(async () => {});
  const phoneInput = view.container.querySelector('#add-customer-phone') as HTMLInputElement;
  return { ...view, onCustomerAdded, phoneInput, i18n };
};

const fillRequiredFields = () => {
  fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.namePlaceholder), {
    target: { value: 'Synthetic Customer' },
  });
  fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.manualAddressPlaceholder), {
    target: { value: 'Synthetic Street 1' },
  });
  fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.floorPlaceholder), {
    target: { value: '2' },
  });
  fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.nameOnRingerPlaceholder), {
    target: { value: 'Synthetic' },
  });
};

const submit = (container: HTMLElement) => {
  fireEvent.submit(container.querySelector('form')!);
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.getSetting.mockImplementation(async (category: string, key: string) =>
    category === 'restaurant' && key === 'phone_country_code' ? 'GR' : null,
  );
  mock.getBranchId.mockResolvedValue('branch-1');
  mock.bridge = {
    terminalConfig: { getBranchId: mock.getBranchId, getSetting: mock.getSetting },
    customers: { invalidateCache: vi.fn(), lookupByPhone: vi.fn() },
  };
  mock.createCustomer.mockResolvedValue({
    success: true,
    data: createdCustomer,
    code: null,
    status: null,
    conflict: false,
    queued: false,
    offline: false,
  });
  mock.updateCustomer.mockImplementation(async (id: string, updates: any) => ({
    success: true,
    data: { ...createdCustomer, id, ...updates, version: 4 },
    code: null,
    status: null,
    conflict: false,
    queued: false,
    offline: false,
  }));
  mock.updateCustomerAddress.mockImplementation(async (id: string, patch: any) => ({
    success: true,
    data: { id, ...patch },
  }));
});

describe('new customer phone', () => {
  it('turns red at the 11th Greek digit: «must have 10 digits (you entered 11)» and does not save', async () => {
    const { container, phoneInput } = await renderModal();
    expect(mock.getSetting).toHaveBeenCalledWith('restaurant', 'phone_country_code');

    fireEvent.change(phoneInput, { target: { value: '69481284741' } });
    const message = 'Phone number must have 10 digits (you entered 11)';
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(phoneInput).toHaveAttribute('aria-invalid', 'true');
    expect(phoneInput.className).toContain('!border-red-500');

    fillRequiredFields();
    submit(container);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
    expect(mock.createCustomer).not.toHaveBeenCalled();
  });

  it('says it in Greek with the founder’s wording', async () => {
    const { phoneInput } = await renderModal({}, 'el');
    fireEvent.change(phoneInput, { target: { value: '69481284741' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Το τηλέφωνο πρέπει να έχει 10 ψηφία (έγραψες 11)');
  });

  it('waits for blur before calling a short number short', async () => {
    const { phoneInput } = await renderModal();
    fireEvent.change(phoneInput, { target: { value: '694812847' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(phoneInput).not.toHaveAttribute('aria-invalid');
    fireEvent.blur(phoneInput);
    expect(screen.getByRole('alert')).toHaveTextContent('Phone number must have 10 digits (you entered 9)');
  });

  it('saves a valid national number with the store country it was validated with', async () => {
    const { container, phoneInput, onCustomerAdded } = await renderModal();
    fireEvent.change(phoneInput, { target: { value: '694 812 8474' } });
    fillRequiredFields();
    submit(container);
    await waitFor(() => expect(mock.createCustomer).toHaveBeenCalledTimes(1));
    expect(mock.createCustomer.mock.calls[0][0]).toMatchObject({
      phone: '694 812 8474',
      phone_country_code: 'GR',
    });
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalledWith(
      expect.objectContaining({ id: createdCustomer.id }),
    ));
  });

  it('reads national numbers in the store’s own country (a Swiss branch)', async () => {
    mock.getSetting.mockResolvedValue('ch');
    const { container, phoneInput } = await renderModal();

    fireEvent.change(phoneInput, { target: { value: '078 123 45 67' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fillRequiredFields();
    submit(container);
    await waitFor(() => expect(mock.createCustomer).toHaveBeenCalledTimes(1));
    expect(mock.createCustomer.mock.calls[0][0]).toMatchObject({
      phone: '078 123 45 67',
      phone_country_code: 'CH',
    });

    // A Swiss number with one digit too many, counted the way it was typed.
    fireEvent.change(phoneInput, { target: { value: '078 123 45 678' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Phone number must have 10 digits (you entered 11)');
  });

  it('falls back to GR when the terminal has no branch country cached', async () => {
    mock.getSetting.mockResolvedValue(null);
    const { container, phoneInput } = await renderModal();
    fireEvent.change(phoneInput, { target: { value: '6948128474' } });
    fillRequiredFields();
    submit(container);
    await waitFor(() => expect(mock.createCustomer).toHaveBeenCalledTimes(1));
    expect(mock.createCustomer.mock.calls[0][0].phone_country_code).toBe('GR');
  });

  it('keeps working on a bridge without getSetting (GR fallback)', async () => {
    mock.bridge = { terminalConfig: { getBranchId: mock.getBranchId }, customers: {} };
    const { phoneInput } = await renderModal();
    fireEvent.change(phoneInput, { target: { value: '69481284741' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Phone number must have 10 digits (you entered 11)');
  });

  it('sends an international number as typed, with no country', async () => {
    const { container, phoneInput } = await renderModal();
    fireEvent.change(phoneInput, { target: { value: '+44 7400 123456' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fillRequiredFields();
    submit(container);
    await waitFor(() => expect(mock.createCustomer).toHaveBeenCalledTimes(1));
    expect(mock.createCustomer.mock.calls[0][0]).toMatchObject({
      phone: '+44 7400 123456',
      phone_country_code: null,
    });
  });

  // One test per typed number (desktop/Android parity table): each re-renders
  // the modal and fires one change per character, so a single loop over the
  // whole table ran into the 5 s default on a loaded CI runner.
  it.each(CUSTOMER_PHONE_TYPING_PARITY_CASES.map((typingCase) => [typingCase.name, typingCase] as const))(
    'turns red while typing exactly where the shared typing table says: %s',
    async (_name, typingCase) => {
      mock.getSetting.mockResolvedValue(typingCase.storeCountry);
      const { phoneInput, unmount } = await renderModal();
      let firstRed: string | null = null;
      for (let length = 1; length <= typingCase.typed.length; length += 1) {
        const prefix = typingCase.typed.slice(0, length);
        fireEvent.change(phoneInput, { target: { value: prefix } });
        if (firstRed === null && phoneInput.getAttribute('aria-invalid') === 'true') {
          firstRed = prefix;
        }
      }
      expect(firstRed, typingCase.name).toBe(typingCase.firstRedPrefix);

      fireEvent.blur(phoneInput);
      // The desktop reads a national number without a cached branch country
      // as Greek (STORE_PHONE_COUNTRY_FALLBACK), where the shared helper alone
      // would ask for a country.
      const expectRed = typingCase.storeCountry === null ? false : typingCase.finalReason !== 'OK';
      expect(phoneInput.getAttribute('aria-invalid') === 'true', `${typingCase.name} after blur`).toBe(expectRed);
      unmount();
    },
  );
});

describe('office rejections are shown on the form, never saved', () => {
  const fillValidForm = (phoneInput: HTMLInputElement) => {
    fireEvent.change(phoneInput, { target: { value: '6948128474' } });
    fillRequiredFields();
  };

  it('INVALID_PHONE lands on the phone field and the form stays open', async () => {
    mock.createCustomer.mockResolvedValue(rejection('INVALID_PHONE'));
    const { container, phoneInput, onCustomerAdded } = await renderModal();
    fillValidForm(phoneInput);
    submit(container);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      en.modals.addCustomer.phoneRejected,
    ));
    expect(phoneInput).toHaveAttribute('aria-invalid', 'true');
    expect(phoneInput.value).toBe('6948128474');
    expect(onCustomerAdded).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('INVALID_PHONE');
  });

  it('COUNTRY_CONTEXT_REQUIRED also lands on the phone field', async () => {
    mock.createCustomer.mockResolvedValue(rejection('COUNTRY_CONTEXT_REQUIRED'));
    const { container, phoneInput } = await renderModal();
    fillValidForm(phoneInput);
    submit(container);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      en.modals.addCustomer.phoneRejected,
    ));
  });

  it('DUPLICATE tells the cashier to select the existing customer', async () => {
    mock.createCustomer.mockResolvedValue(rejection('DUPLICATE', 409));
    const { container, phoneInput, onCustomerAdded } = await renderModal();
    fillValidForm(phoneInput);
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(en.modals.addCustomer.customerExists));
    expect(onCustomerAdded).not.toHaveBeenCalled();
  });

  it('INVALID_COORDINATES lands on the address field', async () => {
    mock.createCustomer.mockResolvedValue(rejection('INVALID_COORDINATES'));
    const { container, phoneInput } = await renderModal();
    fillValidForm(phoneInput);
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(en.modals.addCustomer.addressLocationRejected));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('any other code is named, with no raw office text', async () => {
    mock.createCustomer.mockResolvedValue(rejection('HTTP_422', 422));
    const { container, phoneInput } = await renderModal();
    fillValidForm(phoneInput);
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(
      'The office did not accept the change (code HTTP_422). Check the details and try again.',
    ));
  });

  it('a native failure shows the generic message, not its raw text', async () => {
    mock.createCustomer.mockRejectedValue(new Error('Cannot reach admin dashboard at https://admin.example.test'));
    const { container, phoneInput } = await renderModal();
    fillValidForm(phoneInput);
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(en.modals.addCustomer.failed));
    expect(container.textContent).not.toContain('admin.example.test');
  });
});

describe('editing a customer', () => {
  const legacyCustomer = {
    id: 'c1d2e3f4-0000-4000-8000-000000000001',
    phone: '69481284741',
    phone_country_code: null,
    name: 'Synthetic Legacy',
    version: 3,
    selected_address_id: 'addr-1',
    addresses: [{
      id: 'addr-1', street_address: 'Synthetic Street 1', city: 'Thessaloniki', postal_code: '54621',
      floor_number: '1', name_on_ringer: 'Synthetic', latitude: 40.63, longitude: 22.95, is_default: true, version: 2,
    }],
  };

  it('never blocks an unchanged legacy phone that fails today’s rule, and leaves it out of the update', async () => {
    const { container, onCustomerAdded } = await renderModal({ mode: 'edit', initialCustomer: legacyCustomer });
    // A non-blocking notice, not a red field.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.textContent).toContain('Phone number must have 10 digits (you entered 11)');
    expect(container.textContent).toContain(en.modals.addCustomer.phoneKeptAsSaved);

    fireEvent.change(screen.getByDisplayValue('Synthetic Legacy'), { target: { value: 'Synthetic Renamed' } });
    submit(container);
    await waitFor(() => expect(mock.updateCustomer).toHaveBeenCalledTimes(1));
    const [id, updates, version] = mock.updateCustomer.mock.calls[0];
    expect(id).toBe(legacyCustomer.id);
    expect(version).toBe(3);
    expect(updates.name).toBe('Synthetic Renamed');
    expect(updates).not.toHaveProperty('phone');
    expect(updates).not.toHaveProperty('phone_country_code');
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalled());
  });

  it('blocks a changed phone that fails the rule', async () => {
    const valid = { ...legacyCustomer, phone: '6948128474' };
    const { container } = await renderModal({ mode: 'edit', initialCustomer: valid });
    const phoneInput = container.querySelector('#add-customer-phone') as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: '69481284741' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Phone number must have 10 digits (you entered 11)');
    submit(container);
    await act(async () => {});
    expect(mock.updateCustomer).not.toHaveBeenCalled();
  });

  it('sends a changed valid phone with the store country', async () => {
    const valid = { ...legacyCustomer, phone: '6948128474', phone_country_code: 'GR' };
    const { container } = await renderModal({ mode: 'edit', initialCustomer: valid });
    const phoneInput = container.querySelector('#add-customer-phone') as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: '6948128475' } });
    submit(container);
    await waitFor(() => expect(mock.updateCustomer).toHaveBeenCalledTimes(1));
    expect(mock.updateCustomer.mock.calls[0][1]).toMatchObject({
      phone: '6948128475',
      phone_country_code: 'GR',
    });
  });

  it('keeps a foreign customer’s own country while the phone is unchanged', async () => {
    const cypriot = { ...legacyCustomer, phone: '96123456', phone_country_code: 'CY' };
    const { container } = await renderModal({ mode: 'edit', initialCustomer: cypriot });
    expect(container.textContent).not.toContain(en.modals.addCustomer.phoneKeptAsSaved);
    submit(container);
    await waitFor(() => expect(mock.updateCustomer).toHaveBeenCalledTimes(1));
    expect(mock.updateCustomer.mock.calls[0][1]).not.toHaveProperty('phone');
  });

  it('a version conflict shows the conflict message', async () => {
    mock.updateCustomer.mockResolvedValue(rejection('VERSION_MISMATCH', 409, true));
    const { container, onCustomerAdded } = await renderModal({
      mode: 'edit',
      initialCustomer: { ...legacyCustomer, phone: '6948128474' },
    });
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(en.modals.addCustomer.conflictError));
    expect(onCustomerAdded).not.toHaveBeenCalled();
  });

  it('never blocks an address save on a read-only legacy phone', async () => {
    const onlyAddress = { ...legacyCustomer, editAddressId: 'addr-1' };
    const { container, onCustomerAdded } = await renderModal({ mode: 'editAddress', initialCustomer: onlyAddress });
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '3' } });
    submit(container);
    await waitFor(() => expect(mock.updateCustomerAddress).toHaveBeenCalledTimes(1));
    expect(mock.updateCustomerAddress.mock.calls[0][1]).toMatchObject({ floor_number: '3' });
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalledWith(
      expect.objectContaining({ selected_address_id: 'addr-1', editAddressId: 'addr-1' }),
    ));
  });
});

// Review round (29/09/2026): refusals that come from this register (the
// native customer commands, status null) are not worded as the office's
// answer, and refused ADDRESS writes are named like customer writes instead
// of a generic «try again» that fails the same way every time.
describe('refusals from this register, and refused address writes', () => {
  const syncedCustomer = {
    id: 'c1d2e3f4-0000-4000-8000-000000000003',
    phone: '6948128474',
    phone_country_code: 'GR',
    name: 'Synthetic Customer',
    version: 3,
    selected_address_id: 'addr-1',
    addresses: [{
      id: 'addr-1', street_address: 'Synthetic Street 1', city: 'Thessaloniki', postal_code: '54621',
      floor_number: '1', name_on_ringer: 'Synthetic', latitude: 40.63, longitude: 22.95, is_default: true, version: 2,
    }],
  };
  // The native commands' own refusals carry no HTTP status.
  const localRefusal = (code: string) => ({ ...rejection(code), status: null });

  it.each([
    ['VERSION_REQUIRED', en.modals.addCustomer.versionRequired],
    ['CUSTOMER_SYNC_IN_PROGRESS', en.modals.addCustomer.customerSyncInProgress],
    ['CUSTOMER_NOT_SYNCED', en.modals.addCustomer.customerNotSynced],
  ])('an edit refused here with %s says what to do, not that the office refused it', async (code, text) => {
    mock.updateCustomer.mockResolvedValue(localRefusal(code));
    const { container, onCustomerAdded } = await renderModal({ mode: 'edit', initialCustomer: syncedCustomer });
    fireEvent.change(screen.getByDisplayValue('Synthetic Customer'), { target: { value: 'Synthetic Renamed' } });
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(text));
    expect(container.textContent).not.toContain('The office did not accept');
    expect(container.textContent).not.toContain(code);
    expect(onCustomerAdded).not.toHaveBeenCalled();
  });

  it('an unknown refusal from this register is named as this register’s, not the office’s', async () => {
    mock.createCustomer.mockResolvedValue(localRefusal('LOCAL_CACHE_UNAVAILABLE'));
    const { container, phoneInput } = await renderModal();
    fireEvent.change(phoneInput, { target: { value: '6948128474' } });
    fillRequiredFields();
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(
      'This register could not save the change (code LOCAL_CACHE_UNAVAILABLE).',
    ));
    expect(container.textContent).not.toContain('The office did not accept');
  });

  it('an edited address the office refuses for its location lands on the address field', async () => {
    mock.updateCustomerAddress.mockResolvedValue(rejection('INVALID_COORDINATES'));
    const { container, onCustomerAdded } = await renderModal({
      mode: 'editAddress',
      initialCustomer: { ...syncedCustomer, editAddressId: 'addr-1' },
    });
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '3' } });
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(en.modals.addCustomer.addressLocationRejected));
    expect(container.textContent).not.toContain(en.modals.addCustomer.addressSaveFailed);
    expect(onCustomerAdded).not.toHaveBeenCalled();
  });

  it('an edited address that no longer exists at the office says so', async () => {
    mock.updateCustomerAddress.mockResolvedValue(rejection('NOT_FOUND', 404));
    const { container } = await renderModal({
      mode: 'editAddress',
      initialCustomer: { ...syncedCustomer, editAddressId: 'addr-1' },
    });
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '3' } });
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(en.modals.addCustomer.addressNotFound));
    expect(container.textContent).not.toContain(en.modals.addCustomer.customerNotFound);
  });

  it('a new address for a customer that never reached the office says so', async () => {
    mock.addCustomerAddress.mockResolvedValue(localRefusal('CUSTOMER_NOT_SYNCED'));
    const { container, onCustomerAdded } = await renderModal({ mode: 'addAddress', initialCustomer: syncedCustomer });
    fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.manualAddressPlaceholder), {
      target: { value: 'Synthetic Street 9' },
    });
    fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.floorPlaceholder), { target: { value: '2' } });
    fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.nameOnRingerPlaceholder), {
      target: { value: 'Synthetic' },
    });
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(en.modals.addCustomer.customerNotSynced));
    expect(onCustomerAdded).not.toHaveBeenCalled();
  });

  it('a new address refused without a code keeps the generic message', async () => {
    mock.addCustomerAddress.mockResolvedValue({ success: false });
    const { container } = await renderModal({ mode: 'addAddress', initialCustomer: syncedCustomer });
    fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.manualAddressPlaceholder), {
      target: { value: 'Synthetic Street 9' },
    });
    fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.floorPlaceholder), { target: { value: '2' } });
    fireEvent.change(screen.getByPlaceholderText(en.modals.addCustomer.nameOnRingerPlaceholder), {
      target: { value: 'Synthetic' },
    });
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(en.modals.addCustomer.addressSaveFailed));
  });

  it('full edit names a refused address write too', async () => {
    mock.updateCustomerAddress.mockResolvedValue(localRefusal('CUSTOMER_SYNC_IN_PROGRESS'));
    const { container, onCustomerAdded } = await renderModal({ mode: 'edit', initialCustomer: syncedCustomer });
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '3' } });
    submit(container);
    await waitFor(() => expect(container.textContent).toContain(en.modals.addCustomer.customerSyncInProgress));
    expect(mock.updateCustomerAddress).toHaveBeenCalledTimes(1);
    expect(onCustomerAdded).not.toHaveBeenCalled();
  });
});

describe('form texts that used keys no locale had', () => {
  it('says how long a floor may be instead of a raw key', async () => {
    const { container } = await renderModal({}, 'el');
    fireEvent.change(screen.getByPlaceholderText(el.modals.addCustomer.floorPlaceholder), {
      target: { value: 'x'.repeat(100) },
    });
    expect(container.textContent).toContain('Ο όροφος μπορεί να έχει έως 100 χαρακτήρες.');
    expect(container.textContent).not.toContain('common.validation.maxLength');
  });

  it('names the Caller ID minimise button in the cashier’s language', async () => {
    await renderModal({ callerIdWorkspace: { suspended: false, onMinimize: vi.fn() } }, 'el');
    expect(screen.getByRole('button', { name: 'Ελαχιστοποίηση' })).toBeInTheDocument();
  });
});
