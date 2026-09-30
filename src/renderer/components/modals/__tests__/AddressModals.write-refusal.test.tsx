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

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
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
