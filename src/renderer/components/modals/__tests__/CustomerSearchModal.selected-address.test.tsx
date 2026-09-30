import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Founder decision 5 (29/09/2026): the full "Edit customer" form saves its
// address changes to the address the cashier picked in customer search, not
// to the default one. CustomerSearchModal used to hand the customer on
// without that pick, so AddCustomerModal's full edit prefilled and wrote the
// DEFAULT address.
//
// Desktop 1.4.119: the native address delete answers a refusal with
// {success:false, code, status}; the search modal names it instead of a
// generic «failed» and keeps the address listed.

const mock = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  });
  return {
    toast,
    deleteAddress: vi.fn(),
    updateCustomer: vi.fn(),
    updateCustomerAddress: vi.fn(),
    addCustomerAddress: vi.fn(),
    createCustomer: vi.fn(),
    getSetting: vi.fn(),
    getBranchId: vi.fn(),
  };
});

vi.mock('react-hot-toast', () => ({ default: mock.toast, toast: mock.toast }));
vi.mock('../../../utils/api-helpers', () => ({ posApiGet: vi.fn(), posApiDelete: vi.fn() }));
vi.mock('../../../services/terminal-credentials', () => ({
  getResolvedTerminalCredentials: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
}));
vi.mock('../../../../lib', () => ({
  getBridge: () => ({
    customers: {
      deleteAddress: mock.deleteAddress,
      invalidateCache: vi.fn(),
      lookupByPhone: vi.fn().mockResolvedValue(null),
    },
    terminalConfig: { getBranchId: mock.getBranchId, getSetting: mock.getSetting },
  }),
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
vi.mock('../../../utils/format', () => ({ formatDate: (value: string) => value }));
vi.mock('../../ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ children, isOpen, header }: any) => (isOpen ? <div>{header}{children}</div> : null),
}));
vi.mock('../../forms/FloorPresetPicker', () => ({
  FloorPresetPicker: ({ value, onChange, placeholder }: any) => (
    <input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import en from '../../../../locales/en.json';
import { CustomerSearchModal } from '../CustomerSearchModal';
import { AddCustomerModal } from '../AddCustomerModal';

// Synthetic data only.
const defaultAddress = {
  id: 'addr-default',
  street_address: 'Synthetic Default Street 1',
  city: 'Synthetic City',
  postal_code: '11111',
  floor_number: '1',
  name_on_ringer: 'Synthetic',
  latitude: 40.6301,
  longitude: 22.9501,
  address_type: 'delivery',
  is_default: true,
  created_at: '2026-01-01T00:00:00.000Z',
  version: 2,
};
const pickedAddress = {
  id: 'addr-picked',
  street_address: 'Synthetic Picked Avenue 7',
  city: 'Synthetic Town',
  postal_code: '22222',
  floor_number: '4',
  name_on_ringer: 'Synthetic Work',
  latitude: 40.6402,
  longitude: 22.9602,
  address_type: 'delivery',
  is_default: false,
  created_at: '2026-01-02T00:00:00.000Z',
  version: 5,
};
const customer = {
  id: 'c0ffee00-0000-4000-8000-000000000005',
  phone: '6900000001',
  phone_country_code: 'GR',
  name: 'Synthetic Customer',
  version: 3,
  addresses: [defaultAddress, pickedAddress],
};

const createI18n = async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  return instance;
};

const renderSearch = async (props: Record<string, unknown> = {}) => {
  const i18n = await createI18n();
  const onEditCustomer = vi.fn();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <CustomerSearchModal
        isOpen
        onClose={() => {}}
        onCustomerSelected={vi.fn()}
        onAddNewCustomer={vi.fn()}
        onEditCustomer={onEditCustomer}
        initialCustomer={customer as any}
        {...props}
      />
    </I18nextProvider>,
  );
  await act(async () => {});
  return { ...view, onEditCustomer, i18n };
};

const addressRow = (street: string) => screen.getByText(street).closest('[role="button"]') as HTMLElement;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.getBranchId.mockResolvedValue('branch-1');
  mock.getSetting.mockImplementation(async (category: string, key: string) =>
    category === 'restaurant' && key === 'phone_country_code' ? 'GR' : null,
  );
  mock.updateCustomer.mockImplementation(async (id: string, updates: any) => ({
    success: true,
    data: { ...customer, ...updates, id, version: 4 },
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

describe('full "Edit customer" from customer search (founder decision 5)', () => {
  it('hands on the address the cashier picked, not the default', async () => {
    const { onEditCustomer } = await renderSearch();
    expect(addressRow(defaultAddress.street_address)).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(addressRow(pickedAddress.street_address));
    expect(addressRow(pickedAddress.street_address)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: en.modals.customerSearch.editCustomer }));

    expect(onEditCustomer).toHaveBeenCalledTimes(1);
    const handedOn = onEditCustomer.mock.calls[0][0];
    expect(handedOn.selected_address_id).toBe(pickedAddress.id);
    // Still the full edit, not the address-only editor.
    expect(handedOn.editAddressId).toBeUndefined();
  });

  it('without a pick, hands on the default address as the selected one', async () => {
    const { onEditCustomer } = await renderSearch();
    fireEvent.click(screen.getByRole('button', { name: en.modals.customerSearch.editCustomer }));
    expect(onEditCustomer.mock.calls[0][0].selected_address_id).toBe(defaultAddress.id);
  });

  it('the full edit form then prefills and writes the picked, non-default address', async () => {
    const { onEditCustomer, i18n } = await renderSearch();
    fireEvent.click(addressRow(pickedAddress.street_address));
    fireEvent.click(screen.getByRole('button', { name: en.modals.customerSearch.editCustomer }));
    const handedOn = onEditCustomer.mock.calls[0][0];
    cleanup();

    const onCustomerAdded = vi.fn();
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <AddCustomerModal
          isOpen
          onClose={() => {}}
          onCustomerAdded={onCustomerAdded}
          mode="edit"
          initialCustomer={handedOn}
        />
      </I18nextProvider>,
    );
    await act(async () => {});

    // Prefilled from the picked address.
    expect(screen.getByDisplayValue(pickedAddress.street_address)).toBeInTheDocument();
    expect(screen.getByDisplayValue(pickedAddress.floor_number)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(defaultAddress.street_address)).toBeNull();

    fireEvent.change(screen.getByDisplayValue(pickedAddress.floor_number), { target: { value: '6' } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(mock.updateCustomerAddress).toHaveBeenCalledTimes(1));
    const [addressId, patch, version] = mock.updateCustomerAddress.mock.calls[0];
    expect(addressId).toBe(pickedAddress.id);
    expect(version).toBe(pickedAddress.version);
    expect(patch).toMatchObject({
      street_address: pickedAddress.street_address,
      city: pickedAddress.city,
      postal_code: pickedAddress.postal_code,
      floor_number: '6',
    });
    expect(mock.addCustomerAddress).not.toHaveBeenCalled();
    await waitFor(() => expect(onCustomerAdded).toHaveBeenCalledWith(
      expect.objectContaining({ selected_address_id: pickedAddress.id }),
    ));
  });
});

describe('deleting a saved address from customer search', () => {
  const confirmDelete = async (street: string) => {
    fireEvent.click(within(addressRow(street)).getByRole('button', { name: en.common.delete }));
    expect(mock.toast).toHaveBeenCalledTimes(1);
    const renderConfirmation = mock.toast.mock.calls[0][0] as (toast: { id: string }) => React.ReactNode;
    const confirmation = render(<>{renderConfirmation({ id: 'toast-1' })}</>);
    await act(async () => {
      fireEvent.click(within(confirmation.container).getByRole('button', { name: en.common.delete }));
    });
  };

  it.each([
    ['NOT_FOUND', 404, en.modals.addCustomer.addressNotFound],
    ['CUSTOMER_NOT_SYNCED', null, en.modals.addCustomer.customerNotSynced],
    ['CUSTOMER_SYNC_IN_PROGRESS', null, en.modals.addCustomer.customerSyncInProgress],
  ])('a %s refusal is named and the address stays listed', async (code, status, text) => {
    mock.deleteAddress.mockResolvedValue({ success: false, code, errorCode: code, status, error: code });
    await renderSearch();
    await confirmDelete(pickedAddress.street_address);

    await waitFor(() => expect(mock.toast.error).toHaveBeenCalledWith(text));
    expect(mock.deleteAddress).toHaveBeenCalledWith(customer.id, pickedAddress.id);
    expect(mock.toast.success).not.toHaveBeenCalled();
    expect(screen.getByText(pickedAddress.street_address)).toBeInTheDocument();
    expect(mock.toast.error).not.toHaveBeenCalledWith(code);
  });

  it('an HTTP_4xx refusal names the code inside the office sentence', async () => {
    mock.deleteAddress.mockResolvedValue({ success: false, code: 'HTTP_422', status: 422, error: 'HTTP_422' });
    await renderSearch();
    await confirmDelete(pickedAddress.street_address);
    await waitFor(() => expect(mock.toast.error).toHaveBeenCalledWith(
      'The office did not accept the change (code HTTP_422). Check the details and try again.',
    ));
  });

  it('a delete queued on this register removes the address and says it will sync', async () => {
    mock.deleteAddress.mockResolvedValue({
      success: true,
      queued: true,
      offline: true,
      warning: 'CUSTOMER_ADDRESS_SAVED_OFFLINE',
      data: { id: pickedAddress.id, deleted: true },
    });
    await renderSearch();
    await confirmDelete(pickedAddress.street_address);
    await waitFor(() => expect(mock.toast.success).toHaveBeenCalledWith(en.modals.customerSearch.deleteAddressQueued));
    expect(screen.queryByText(pickedAddress.street_address)).toBeNull();
    expect(mock.toast.error).not.toHaveBeenCalled();
  });
});
