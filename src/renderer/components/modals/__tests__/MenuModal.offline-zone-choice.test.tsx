import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Offline week Ω6β (coordinator decision 22/10/2026), desktop menu.
// Symptom: offline, a saved address whose Google point is older than 28 days
// (FIX-03) could not be located; the zone was "not checked" and the order went
// out with delivery fee 0 although the cashier never chose anything.
// Now the cashier picks the zone from the store's cached zones, its fee
// applies and the order carries the "zone chosen manually" marker.
// Never fee 0 without that choice; never the expired point. Synthetic data.

const mocks = vi.hoisted(() => ({
  offline: false,
  listeners: new Set<(reachable: boolean, previous: boolean | null) => void>(),
  validateAddress: vi.fn(),
  search: vi.fn(),
  resolve: vi.fn(),
  getDeliveryZones: vi.fn(),
  updateAddress: vi.fn(async () => ({ success: true })),
  toastError: vi.fn(),
}));

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { error: mocks.toastError, success: vi.fn(), dismiss: vi.fn() });
  return { default: toast, toast };
});

vi.mock('../../../services/server-reachability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/server-reachability')>()),
  isTillKnownOffline: () => mocks.offline,
  subscribeServerReachability: (listener: (reachable: boolean, previous: boolean | null) => void) => {
    mocks.listeners.add(listener);
    return () => {
      mocks.listeners.delete(listener);
    };
  },
}));

vi.mock('../../../contexts/theme-context', () => {
  const theme = { resolvedTheme: 'light' };
  return { useTheme: () => theme };
});

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const translation = {
    t: (key: string, fallback?: string | { defaultValue?: string }) => (
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
    ),
  };
  return { ...actual, useTranslation: () => translation };
});

vi.mock('../../../contexts/i18n-context', () => {
  const i18n = { language: 'en', setLanguage: vi.fn(), t: (key: string) => key };
  return { useI18n: () => i18n };
});

vi.mock('../../../contexts/shift-context', () => {
  const shiftValue = {
    staff: { branchId: 'branch-1', organizationId: 'org-1', terminalId: 'terminal-1' },
    activeShift: null,
    isShiftActive: false,
    refreshActiveShift: vi.fn(async () => undefined),
  };
  return { useShift: () => shiftValue };
});

vi.mock('../../../hooks/useDiscountSettings', () => {
  const value = { maxDiscountPercentage: 100 };
  return { useDiscountSettings: () => value };
});

vi.mock('../../../hooks/useFeaturedItems', () => {
  const value = {
    topSellerIds: [],
    rankedTopSellerIds: [],
    topSellers: [],
    lastUpdated: null,
    refresh: vi.fn(async () => {}),
    isLoading: false,
    error: null,
    isTopSeller: () => false,
  };
  return { useFeaturedItems: () => value };
});

vi.mock('../../../hooks/useDeliveryValidation', () => {
  const value = { validateAddress: mocks.validateAddress, isValidating: false };
  return { useDeliveryValidation: () => value };
});

vi.mock('../../../hooks/useAcquiredModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useAcquiredModules')>();
  const value = {
    hasModule: (id: string) => id === actual.MODULE_IDS.DELIVERY || id === actual.MODULE_IDS.DELIVERY_ZONES,
  };
  return { ...actual, useAcquiredModules: () => value };
});

vi.mock('../../../hooks/useKdsLiveDraftSync', () => ({
  useKdsLiveDraftSync: vi.fn(),
}));

vi.mock('../../../services/MenuService', () => ({
  menuService: {
    getMenuItems: vi.fn(async () => []),
    getMenuCategories: vi.fn(async () => []),
    getIngredients: vi.fn(async () => []),
    getMenuCombos: vi.fn(async () => []),
    getMenuItemById: vi.fn(async () => null),
    getLoadingStatus: () => ({ menuItems: 'success' }),
    clearCacheEntry: vi.fn(),
  },
}));

vi.mock('../../../services/terminal-credentials', () => ({
  getCachedTerminalCredentials: vi.fn(() => ({ branchId: 'branch-1', organizationId: 'org-1', terminalId: 'terminal-1' })),
  refreshTerminalCredentialCache: vi.fn(async () => ({ branchId: 'branch-1', organizationId: 'org-1', terminalId: 'terminal-1' })),
}));

vi.mock('../../../services/address-workflow', async () => {
  const houseNumber = await import('../../../services/address-house-number');
  return {
    ...houseNumber,
    createAddressSessionToken: () => 'addr_session_test',
    searchAddressSuggestions: mocks.search,
    resolveAddressSuggestion: mocks.resolve,
  };
});

vi.mock('../../../utils/api-helpers', () => ({
  posApiGet: vi.fn(async () => ({ success: false })),
  posApiPost: vi.fn(async () => ({ success: false })),
}));

vi.mock('../../../utils/catalog-offers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/catalog-offers')>()),
  validateCatalogOffers: vi.fn(async () => null),
}));

const draftStorage = vi.hoisted(() => ({ draft: null as any, generation: 0 }));
vi.mock('../../../../lib', async (importOriginal) => {
  const bridge = {
    invoke: vi.fn(async (command: string, input: any) => {
      if (command === 'checkout_draft_check_admission') return { success: true, currency: 'EUR' };
      if (command === 'checkout_draft_inspect') return { success: true, outcome: 'not_found', canCollect: false };
      if (command === 'checkout_draft_put') { draftStorage.draft = input.draft; draftStorage.generation++; }
      if (command === 'checkout_draft_delete') { draftStorage.draft = null; draftStorage.generation++; }
      return { success: true, scope: { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'terminal-1' }, generation: draftStorage.generation, draft: draftStorage.draft };
    }),
    settings: { get: vi.fn(async () => null) },
    orders: { getById: vi.fn(async () => null) },
    customers: { updateAddress: mocks.updateAddress },
    branchData: { getDeliveryZones: mocks.getDeliveryZones },
    loyalty: {
      getSettings: vi.fn(async () => null),
      getCustomerBalance: vi.fn(async () => null),
    },
  };
  return {
    ...(await importOriginal<typeof import('../../../../lib')>()),
    // The desktop till (Tauri): zones come from the native local-first read.
    isBrowser: () => false,
    getBridge: () => bridge,
  };
});

vi.mock('../../menu/MenuCategoryTabs', () => ({
  MenuCategoryTabs: () => <div data-testid="menu-category-tabs" />,
}));
vi.mock('../../menu/MenuItemGrid', () => ({
  MenuItemGrid: ({ onQuickAdd }: any) => (
    <button onClick={() => onQuickAdd({
      id: 'espresso', name: 'Espresso', category_id: 'coffee', price: 8, delivery_price: 6,
    }, 1)}>Add espresso</button>
  ),
}));
vi.mock('../../menu/MenuCart', () => ({
  MenuCart: ({ onCheckout, deliveryFeeStatus, deliveryFee, deliveryZoneChoice }: any) => (
    <div data-testid="menu-cart">
      <span data-testid="fee-status">{deliveryFeeStatus}</span>
      <span data-testid="delivery-fee">{String(deliveryFee)}</span>
      {deliveryZoneChoice && (
        <div data-testid="zone-choice">
          {deliveryZoneChoice.options.map((option: any) => (
            <button key={option.id} onClick={() => deliveryZoneChoice.onChoose(option.id)}>
              Choose {option.name}
            </button>
          ))}
          <span data-testid="chosen-zone">{deliveryZoneChoice.selectedZoneId ?? 'none'}</span>
        </div>
      )}
      <button onClick={onCheckout}>Checkout</button>
    </div>
  ),
}));
vi.mock('../../menu/MenuItemModal', () => ({ MenuItemModal: () => null }));
vi.mock('../../menu/ComboChoiceModal', () => ({ ComboChoiceModal: () => null }));
vi.mock('../PaymentModal', () => ({
  PaymentModal: ({ isOpen, onPaymentComplete, onBeforePayment, orderTotal }: any) => (isOpen ? (
    <div data-testid="payment-modal">
      <button onClick={async () => {
        const data = { method: 'cash', amount: orderTotal };
        if (await onBeforePayment(data)) await onPaymentComplete(data);
      }}>Confirm cash</button>
    </div>
  ) : null),
}));
vi.mock('../LoyaltyRedeemModal', () => ({ LoyaltyRedeemModal: () => null }));

import { MenuModal } from '../MenuModal';
import { materializeCustomerAddresses, toCanonicalCustomerAddress } from '../../../utils/customer-addresses';
import { clearSavedAddressGeolocationMemo } from '../../../utils/saved-address-geolocation';
import { deliveryZoneSelectionMetadata } from '../../../utils/delivery-fee';

const DAY = 86_400_000;
const CUSTOMER_ID = '0b9c3a52-6f1e-4d2a-9b7c-1f2e3d4c5b6a';
const customer = { id: CUSTOMER_ID, name: 'Test Customer', phone: '6948128474' };
const SAVED_POINT = { lat: 40.5836, lng: 22.9502 };

/** What OrderDashboard hands the menu for a saved Google address fetched `ageDays` ago. */
function canonicalGoogleAddress(ageDays: number) {
  const [materialized] = materializeCustomerAddresses({
    id: CUSTOMER_ID,
    addresses: [{
      id: 'addr-1',
      customer_id: CUSTOMER_ID,
      street_address: 'Odos Dokimis 12',
      city: 'Kalamaria',
      postal_code: '55133',
      latitude: SAVED_POINT.lat,
      longitude: SAVED_POINT.lng,
      coordinate_source: 'google',
      google_place_id: 'place-test-1',
      geocoded_at: new Date(Date.now() - ageDays * DAY).toISOString(),
      is_default: true,
      address_type: 'delivery',
      created_at: '2026-05-20T10:00:00Z',
      version: 2,
    }],
  });
  return toCanonicalCustomerAddress(materialized);
}

const cachedZones = {
  success: true,
  data: {
    success: true,
    zones: [
      { id: 'zone-a', name: 'Zone A', delivery_fee: 1, minimum_order_amount: 0, is_active: true },
      { id: 'zone-b', name: 'Zone B', delivery_fee: 2.5, minimum_order_amount: 0, is_active: true },
    ],
  },
  meta: { source: 'cache' },
};

const inZoneAnswer = {
  success: true,
  isValid: true,
  validation_status: 'in_zone',
  zone_checked: true,
  zone: { id: 'zone-a', name: 'Zone A', deliveryFee: 1, minimumOrderAmount: 0 },
};

function setOffline(offline: boolean) {
  mocks.offline = offline;
  act(() => {
    for (const listener of [...mocks.listeners]) listener(!offline, offline);
  });
}

function renderMenu(address: unknown, onOrderComplete = vi.fn(async () => true)) {
  render(
    <MenuModal
      isOpen
      onClose={vi.fn()}
      orderType="delivery"
      selectedCustomer={customer}
      selectedAddress={address as any}
      onOrderComplete={onOrderComplete}
    />,
  );
  return onOrderComplete;
}

beforeEach(() => {
  clearSavedAddressGeolocationMemo();
  mocks.offline = false;
  mocks.listeners.clear();
  mocks.validateAddress.mockReset().mockResolvedValue(inZoneAnswer);
  mocks.search.mockReset().mockResolvedValue([]);
  mocks.resolve.mockReset();
  mocks.getDeliveryZones.mockReset().mockResolvedValue(cachedZones);
  mocks.updateAddress.mockClear();
  mocks.toastError.mockReset();
  draftStorage.draft = null;
  draftStorage.generation = 0;
});

afterEach(() => {
  cleanup();
});

describe('MenuModal offline: a saved address whose Google point expired', () => {
  it('requires the cashier to choose the zone; the chosen zone fee and the marker reach the order', async () => {
    mocks.offline = true;
    const onOrderComplete = renderMenu(canonicalGoogleAddress(40));

    await waitFor(() => expect(screen.getByTestId('fee-status')).toHaveTextContent('requires_zone_choice'));
    await waitFor(() => expect(screen.getByText('Choose Zone B')).toBeInTheDocument());
    // Never the expired point, never a search offline.
    expect(mocks.validateAddress).not.toHaveBeenCalledWith(expect.objectContaining(SAVED_POINT), expect.anything());
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.getDeliveryZones).toHaveBeenCalledWith({ branch_id: 'branch-1' });

    // No fee 0 without a choice: checkout is refused with its own message.
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('menu.cart.offlineZoneChoiceRequired'));
    expect(screen.queryByTestId('payment-modal')).toBeNull();

    fireEvent.click(screen.getByText('Choose Zone B'));
    await waitFor(() => expect(screen.getByTestId('fee-status')).toHaveTextContent('resolved'));
    expect(screen.getByTestId('delivery-fee')).toHaveTextContent('2.5');
    expect(screen.getByTestId('chosen-zone')).toHaveTextContent('zone-b');

    fireEvent.click(screen.getByText('Checkout'));
    await waitFor(() => expect(screen.getByTestId('payment-modal')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Confirm cash'));
    await waitFor(() => expect(onOrderComplete).toHaveBeenCalledTimes(1));

    const submission = (onOrderComplete.mock.calls as any[])[0][0];
    expect(submission.deliveryFee).toBe(2.5);
    expect(submission.deliveryZoneInfo.zone).toMatchObject({ id: 'zone-b', name: 'Zone B', deliveryFee: 2.5 });
    // OrderDashboard / OrderFlow / NewOrderPage put this marker in ghost_metadata.
    expect(deliveryZoneSelectionMetadata(null, 'delivery', submission.deliveryZoneInfo)).toEqual({
      delivery_zone_selection: {
        source: 'manual',
        reason: 'offline_address_not_located',
        zone_id: 'zone-b',
        zone_name: 'Zone B',
        delivery_fee: 2.5,
      },
    });
  });

  it('when the connection returns, the address is located online again and its checked zone replaces the choice', async () => {
    mocks.offline = true;
    renderMenu(canonicalGoogleAddress(40));
    await waitFor(() => expect(screen.getByText('Choose Zone B')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Choose Zone B'));
    await waitFor(() => expect(screen.getByTestId('delivery-fee')).toHaveTextContent('2.5'));

    const located = { lat: 40.5841, lng: 22.9511 };
    mocks.search.mockResolvedValue([{
      place_id: 'place-in-area',
      name: 'Odos Dokimis 12',
      displayLabel: 'Odos Dokimis 12',
      main_text: 'Odos Dokimis 12',
      secondary_text: 'Kalamaria 551 33',
      formatted_address: 'Odos Dokimis 12, Kalamaria 551 33',
      source: 'online',
    }]);
    mocks.resolve.mockResolvedValue({
      streetAddress: 'Odos Dokimis 12',
      city: 'Kalamaria',
      postalCode: '551 33',
      coordinates: located,
      resolvedStreetNumber: '12',
      validationSource: 'online',
    });
    setOffline(false);

    await waitFor(() => expect(mocks.validateAddress).toHaveBeenCalledWith(located, 0));
    await waitFor(() => expect(screen.queryByTestId('zone-choice')).toBeNull());
    expect(screen.getByTestId('fee-status')).toHaveTextContent('resolved');
    expect(screen.getByTestId('delivery-fee')).toHaveTextContent('1');
  });
});

describe('MenuModal: no zone choice where the zone can be computed', () => {
  it('offline, a fresh point (≤28 days): no choice, the zone is checked with the point as today', async () => {
    mocks.offline = true;
    renderMenu(canonicalGoogleAddress(5));

    await waitFor(() => expect(mocks.validateAddress).toHaveBeenCalledWith(SAVED_POINT, 0));
    await waitFor(() => expect(screen.getByTestId('fee-status')).toHaveTextContent('resolved'));
    expect(screen.getByTestId('delivery-fee')).toHaveTextContent('1');
    expect(screen.queryByTestId('zone-choice')).toBeNull();
  });

  it('online, an expired point: unchanged (located online; if not found, "not checked" and the order proceeds)', async () => {
    renderMenu(canonicalGoogleAddress(40));

    await waitFor(() => expect(screen.getByTestId('fee-status')).toHaveTextContent('not_checked'));
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('zone-choice')).toBeNull();

    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));
    await waitFor(() => expect(screen.getByTestId('payment-modal')).toBeInTheDocument());
  });
});
