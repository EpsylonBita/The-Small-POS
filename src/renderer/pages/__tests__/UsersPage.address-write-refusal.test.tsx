import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Desktop 1.4.119 (rel-desktop-rust): the native address commands answer a
// refused write with Ok({success:false, code, status, error}) and save or
// queue nothing. The Customers page showed only «Failed to update address» /
// «Failed to delete address», which fails the same way on every retry; it
// now names the refusal, keeps the address as it was (still in edit mode
// for an update, still listed for a delete) and never reports it as saved.

const mock = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() });
  return {
    toast,
    search: vi.fn(),
    lookupById: vi.fn(),
    updateAddress: vi.fn(),
    deleteAddress: vi.fn(),
  };
});

vi.mock('react-hot-toast', () => ({ default: mock.toast, toast: mock.toast }));
vi.mock('framer-motion', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  const components = new Map<string, React.FC<any>>();
  const MOTION_ONLY = ['initial', 'animate', 'exit', 'variants', 'transition', 'whileTap', 'whileHover', 'layout'];
  return {
    motion: new Proxy({}, {
      get: (_target, tag: string) => {
        let component = components.get(tag);
        if (!component) {
          component = ({ children, ...props }: any) => {
            const domProps = Object.fromEntries(
              Object.entries(props).filter(([key]) => !MOTION_ONLY.includes(key)),
            );
            return ReactModule.createElement(tag, domProps, children);
          };
          components.set(tag, component);
        }
        return component;
      },
    }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock('../../../lib', () => ({
  getBridge: () => ({
    customers: {
      search: mock.search,
      lookupById: mock.lookupById,
      updateAddress: mock.updateAddress,
      deleteAddress: mock.deleteAddress,
    },
  }),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));
vi.mock('../../utils/api-helpers', () => ({
  posApiGet: vi.fn().mockResolvedValue({ success: false }),
  posApiFetch: vi.fn().mockResolvedValue({ success: false }),
}));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

import en from '../../../locales/en.json';
import el from '../../../locales/el.json';
import UsersPage from '../UsersPage';

// Synthetic data only.
const savedAddress = {
  id: 'addr-1',
  customer_id: 'c0ffee00-0000-4000-8000-000000000009',
  version: 4,
  street_address: 'Synthetic Street 5',
  city: 'Synthetic City',
  postal_code: '11111',
  floor_number: '2',
  is_default: true,
  latitude: 40.6301,
  longitude: 22.9501,
};
const customer = {
  id: savedAddress.customer_id,
  name: 'Synthetic Customer',
  phone: '6900000001',
  loyalty_points: 0,
  total_orders: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  addresses: [savedAddress],
};

const refusal = (code: string, status: number | null = 400, conflict = false) => ({
  success: false,
  code,
  errorCode: code,
  status,
  error: code,
  ...(conflict ? { conflict: true } : {}),
});

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

const openCustomerDetails = async (lng: 'en' | 'el' = 'en') => {
  const locale = lng === 'el' ? el : en;
  const i18n = await createI18n(lng);
  render(
    <I18nextProvider i18n={i18n}>
      <UsersPage />
    </I18nextProvider>,
  );
  const view = await screen.findByRole('button', { name: locale.users.viewDetails });
  await act(async () => {
    fireEvent.click(view);
  });
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(`${savedAddress.street_address}, ${savedAddress.city}`);
  return { dialog, locale };
};

const saveEditedAddress = async (dialog: HTMLElement, locale: typeof en) => {
  fireEvent.click(within(dialog).getByRole('button', { name: locale.customer.actions.editAddress }));
  fireEvent.change(within(dialog).getByDisplayValue(savedAddress.floor_number), { target: { value: '3' } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: locale.common.actions.save }));
  });
};

const confirmDelete = async (dialog: HTMLElement, locale: typeof en) => {
  fireEvent.click(within(dialog).getByRole('button', { name: locale.customer.actions.deleteAddress }));
  const confirmation = await screen.findByRole('dialog', { name: locale.users.deleteAddressTitle });
  await act(async () => {
    fireEvent.click(within(confirmation).getByRole('button', { name: locale.common.actions.delete }));
  });
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.search.mockResolvedValue([customer]);
  mock.lookupById.mockResolvedValue(customer);
});

describe('Customers page: saving an edited address', () => {
  it.each([
    ['INVALID_COORDINATES', 400, false, en.modals.addCustomer.addressLocationRejected],
    ['NOT_FOUND', 404, false, en.modals.addCustomer.addressNotFound],
    ['VERSION_MISMATCH', 409, true, en.modals.addCustomer.conflictError],
    ['CUSTOMER_NOT_SYNCED', null, false, en.modals.addCustomer.customerNotSynced],
    ['CUSTOMER_SYNC_IN_PROGRESS', null, false, en.modals.addCustomer.customerSyncInProgress],
    ['HTTP_422', 422, false, 'The office did not accept the change (code HTTP_422). Check the details and try again.'],
  ])('a %s refusal is named and the address stays in edit mode', async (code, status, conflict, text) => {
    mock.updateAddress.mockResolvedValue(refusal(code, status, conflict));
    const { dialog } = await openCustomerDetails();
    await saveEditedAddress(dialog, en);

    await waitFor(() => expect(mock.toast.error).toHaveBeenCalledWith(text));
    expect(mock.updateAddress).toHaveBeenCalledWith(
      savedAddress.id,
      expect.objectContaining({ customer_id: customer.id, floor_number: '3' }),
      savedAddress.version,
    );
    expect(mock.toast.success).not.toHaveBeenCalled();
    expect(mock.toast.error).not.toHaveBeenCalledWith(code);
    // Still editing, so the cashier can fix it and save again.
    expect(within(dialog).getByDisplayValue('3')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: en.common.actions.save })).toBeInTheDocument();
  });

  it('speaks the cashier’s language', async () => {
    mock.updateAddress.mockResolvedValue(refusal('INVALID_COORDINATES'));
    const { dialog, locale } = await openCustomerDetails('el');
    await saveEditedAddress(dialog, locale);
    await waitFor(() => expect(mock.toast.error).toHaveBeenCalledWith(el.modals.addCustomer.addressLocationRejected));
  });

  it('a native failure shows the generic message, not its raw text', async () => {
    mock.updateAddress.mockRejectedValue(new Error('Customer/address not found'));
    const { dialog } = await openCustomerDetails();
    await saveEditedAddress(dialog, en);
    await waitFor(() => expect(mock.toast.error).toHaveBeenCalledWith(en.users.updateAddressError));
  });

  it('an update queued on this register says so in the cashier’s language and leaves edit mode', async () => {
    mock.updateAddress.mockResolvedValue({
      success: true,
      queued: true,
      offline: true,
      warning: 'CUSTOMER_ADDRESS_SAVED_OFFLINE',
      data: { ...savedAddress, floor_number: '3' },
    });
    const { dialog, locale } = await openCustomerDetails('el');
    await saveEditedAddress(dialog, locale);
    await waitFor(() => expect(mock.toast.success).toHaveBeenCalledWith(el.users.savedLocallyQueued));
    expect(mock.toast.error).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole('button', { name: el.common.actions.save })).toBeNull();
  });

  it('an update the office saved says so and leaves edit mode', async () => {
    mock.updateAddress.mockResolvedValue({ success: true, data: { ...savedAddress, floor_number: '3', version: 5 } });
    const { dialog } = await openCustomerDetails();
    await saveEditedAddress(dialog, en);
    await waitFor(() => expect(mock.toast.success).toHaveBeenCalledWith(en.users.updateAddressSuccess));
    expect(within(dialog).queryByRole('button', { name: en.common.actions.save })).toBeNull();
  });
});

describe('Customers page: deleting an address', () => {
  it.each([
    ['NOT_FOUND', 404, en.modals.addCustomer.addressNotFound],
    ['CUSTOMER_NOT_SYNCED', null, en.modals.addCustomer.customerNotSynced],
    ['CUSTOMER_SYNC_IN_PROGRESS', null, en.modals.addCustomer.customerSyncInProgress],
    ['HTTP_400', 400, 'The office did not accept the change (code HTTP_400). Check the details and try again.'],
  ])('a %s refusal is named and the address stays listed', async (code, status, text) => {
    mock.deleteAddress.mockResolvedValue(refusal(code, status));
    const { dialog } = await openCustomerDetails();
    await confirmDelete(dialog, en);

    await waitFor(() => expect(mock.toast.error).toHaveBeenCalledWith(text));
    expect(mock.deleteAddress).toHaveBeenCalledWith(customer.id, savedAddress.id);
    expect(mock.toast.success).not.toHaveBeenCalled();
    expect(within(dialog).getByText(`${savedAddress.street_address}, ${savedAddress.city}`)).toBeInTheDocument();
  });

  it('a delete queued on this register removes the address and says it will sync', async () => {
    mock.deleteAddress.mockResolvedValue({
      success: true,
      queued: true,
      offline: true,
      warning: 'CUSTOMER_ADDRESS_SAVED_OFFLINE',
      data: { id: savedAddress.id, deleted: true },
    });
    const { dialog } = await openCustomerDetails();
    await confirmDelete(dialog, en);
    await waitFor(() => expect(mock.toast.success).toHaveBeenCalledWith(en.users.deleteAddressQueued));
    expect(within(dialog).queryByText(`${savedAddress.street_address}, ${savedAddress.city}`)).toBeNull();
  });
});
