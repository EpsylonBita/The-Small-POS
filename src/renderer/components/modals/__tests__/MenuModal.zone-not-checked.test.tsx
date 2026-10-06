import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Delivery-zone behaviour of the order menu for saved addresses WITHOUT
// coordinates (about two thirds of one store's addresses).
// Symptom: the desktop checked the point (0,0) for them ("out of zone",
// cached 30 min) and never ran the automatic geolocation.
// Founder rule (2026-09-29): geolocate automatically, accept only when the
// municipality or postal code matches; otherwise the order proceeds with a
// "zone not checked" notice and a re-pick action — never "out of zone".

const mocks = vi.hoisted(() => ({
  validateAddress: vi.fn(),
  search: vi.fn(),
  resolve: vi.fn(),
  updateAddress: vi.fn(async () => ({ success: true })),
  feeStatuses: [] as string[],
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
beforeEach(() => { draftStorage.draft = null; draftStorage.generation = 0; });
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
    loyalty: {
      getSettings: vi.fn(async () => null),
      getCustomerBalance: vi.fn(async () => null),
    },
  };
  return {
    ...(await importOriginal<typeof import('../../../../lib')>()),
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
  MenuCart: ({ onCheckout, deliveryFeeStatus, onRepickDeliveryAddress }: any) => {
    mocks.feeStatuses.push(deliveryFeeStatus);
    return (
    <div data-testid="menu-cart">
      <span data-testid="fee-status">{deliveryFeeStatus}</span>
      {onRepickDeliveryAddress && <button onClick={onRepickDeliveryAddress}>Re-pick address</button>}
      <button onClick={onCheckout}>Checkout</button>
    </div>
    );
  },
}));
vi.mock('../../menu/MenuItemModal', () => ({ MenuItemModal: () => null }));
vi.mock('../../menu/ComboChoiceModal', () => ({ ComboChoiceModal: () => null }));
vi.mock('../PaymentModal', () => ({
  PaymentModal: ({ isOpen }: any) => (isOpen ? <div data-testid="payment-modal">payment</div> : null),
}));
vi.mock('../LoyaltyRedeemModal', () => ({ LoyaltyRedeemModal: () => null }));

import { MenuModal, isMenuTopMostDialog } from '../MenuModal';
import { LiquidGlassModal } from '../../ui/pos-glass-components';
import { materializeCustomerAddresses, toCanonicalCustomerAddress } from '../../../utils/customer-addresses';
import { clearSavedAddressGeolocationMemo } from '../../../utils/saved-address-geolocation';

// Synthetic data only.
const IN_AREA_POINT = { lat: 40.5836, lng: 22.9502 };

const CUSTOMER_ID = '0b9c3a52-6f1e-4d2a-9b7c-1f2e3d4c5b6a';
const customer = { id: CUSTOMER_ID, name: 'Test Customer', phone: '6948128474' };

/** What OrderDashboard hands the menu for a server row without coordinates. */
function canonicalAddressWithoutPoint() {
  const [materialized] = materializeCustomerAddresses({
    id: CUSTOMER_ID,
    addresses: [{
      id: 'addr-1',
      customer_id: CUSTOMER_ID,
      street_address: 'Odos Dokimis 12',
      city: 'Kalamaria',
      postal_code: '55133',
      latitude: null,
      longitude: null,
      coordinates: null,
      is_default: true,
      address_type: 'delivery',
      created_at: '2026-05-20T10:00:00Z',
      version: 2,
    }],
  });
  return toCanonicalCustomerAddress(materialized);
}

function suggestion(placeId: string, secondary: string) {
  return {
    place_id: placeId,
    name: 'Odos Dokimis 12',
    displayLabel: 'Odos Dokimis 12',
    main_text: 'Odos Dokimis 12',
    secondary_text: secondary,
    formatted_address: `Odos Dokimis 12, ${secondary}`,
    source: 'online' as const,
  };
}

const notCheckedAnswer = {
  success: true,
  isValid: false,
  validation_status: 'requires_selection',
  suggestedAction: 'geocode_first',
  reason_code: 'coordinates_missing',
  zone_checked: false,
};

const inZoneAnswer = {
  success: true,
  isValid: true,
  validation_status: 'in_zone',
  zone_checked: true,
  zone: { id: 'zone-1', name: 'Zone 1', deliveryFee: 0, minimumOrderAmount: 0 },
};

beforeEach(() => {
  clearSavedAddressGeolocationMemo();
  mocks.validateAddress.mockReset();
  mocks.search.mockReset();
  mocks.resolve.mockReset();
  mocks.updateAddress.mockClear();
  mocks.feeStatuses.length = 0;
  mocks.validateAddress.mockImplementation(async (target: unknown) => (
    typeof target === 'string' ? notCheckedAnswer : inZoneAnswer
  ));
});

afterEach(() => {
  cleanup();
});

function isNullIsland(target: unknown): boolean {
  return Boolean(target) && typeof target === 'object'
    && (target as { lat?: number }).lat === 0 && (target as { lng?: number }).lng === 0;
}

describe('MenuModal: saved address without coordinates', () => {
  it('never checks (0,0); a same-street match in another area leaves the zone "not checked" and the order proceeds', async () => {
    mocks.search.mockResolvedValue([suggestion('place-other-area', 'Thessaloniki 546 30')]);
    mocks.resolve.mockResolvedValue({
      streetAddress: 'Odos Dokimis 12',
      city: 'Thessaloniki',
      postalCode: '546 30',
      coordinates: { lat: 40.6401, lng: 22.9444 },
      resolvedStreetNumber: '12',
      addressFingerprint: 'fp',
      validationSource: 'online',
    });
    const onRepick = vi.fn();

    render(
      <MenuModal
        isOpen
        onClose={vi.fn()}
        orderType="delivery"
        selectedCustomer={customer}
        selectedAddress={canonicalAddressWithoutPoint()}
        onRepickDeliveryAddress={onRepick}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('fee-status')).toHaveTextContent('not_checked'));
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.validateAddress.mock.calls.some(([target]) => isNullIsland(target))).toBe(false);
    // Not located: "not checked" is answered locally. A text-only request
    // could only answer requires_selection (same as Android).
    expect(mocks.validateAddress).not.toHaveBeenCalled();
    expect(mocks.updateAddress).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Re-pick address'));
    expect(onRepick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));
    await waitFor(() => expect(screen.getByTestId('payment-modal')).toBeInTheDocument());
  });

  it('accepts a geolocated point in the saved postal code, checks the zone with it and writes it back', async () => {
    mocks.search.mockResolvedValue([suggestion('place-in-area', 'Kalamaria 551 33')]);
    mocks.resolve.mockResolvedValue({
      streetAddress: 'Odos Dokimis 12',
      city: 'Kalamaria',
      postalCode: '551 33',
      coordinates: IN_AREA_POINT,
      resolvedStreetNumber: '12',
      addressFingerprint: 'fp',
      validationSource: 'online',
    });

    render(
      <MenuModal
        isOpen
        onClose={vi.fn()}
        orderType="delivery"
        selectedCustomer={customer}
        selectedAddress={canonicalAddressWithoutPoint()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('fee-status')).toHaveTextContent('resolved'));
    expect(mocks.validateAddress).toHaveBeenCalledWith(IN_AREA_POINT, 0);
    // While the address was being located the cart never said "not checked".
    expect(mocks.feeStatuses).not.toContain('not_checked');
    expect(mocks.updateAddress).toHaveBeenCalledWith(
      'addr-1',
      expect.objectContaining({ customer_id: CUSTOMER_ID, latitude: IN_AREA_POINT.lat, longitude: IN_AREA_POINT.lng }),
      2,
    );
  });

  it('does not let a caller\'s "not checked" verdict stop its own geolocated check', async () => {
    mocks.search.mockResolvedValue([suggestion('place-in-area', 'Kalamaria 551 33')]);
    mocks.resolve.mockResolvedValue({
      streetAddress: 'Odos Dokimis 12',
      city: 'Kalamaria',
      postalCode: '551 33',
      coordinates: IN_AREA_POINT,
      resolvedStreetNumber: '12',
      addressFingerprint: 'fp',
      validationSource: 'online',
    });

    render(
      <MenuModal
        isOpen
        onClose={vi.fn()}
        orderType="delivery"
        selectedCustomer={customer}
        selectedAddress={canonicalAddressWithoutPoint()}
        deliveryZoneInfo={notCheckedAnswer as never}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('fee-status')).toHaveTextContent('resolved'));
    expect(mocks.validateAddress).toHaveBeenCalledWith(IN_AREA_POINT, 0);
  });

  it('does not search again when the parent re-renders the same address', async () => {
    mocks.search.mockResolvedValue([]);
    const view = render(
      <MenuModal isOpen onClose={vi.fn()} orderType="delivery" selectedCustomer={customer} selectedAddress={canonicalAddressWithoutPoint()} />,
    );
    await waitFor(() => expect(screen.getByTestId('fee-status')).toHaveTextContent('not_checked'));

    for (let i = 0; i < 3; i += 1) {
      view.rerender(
        <MenuModal isOpen onClose={vi.fn()} orderType="delivery" selectedCustomer={customer} selectedAddress={canonicalAddressWithoutPoint()} />,
      );
    }
    await waitFor(() => expect(screen.getByTestId('fee-status')).toHaveTextContent('not_checked'));
    expect(mocks.search).toHaveBeenCalledTimes(1);
  });
});

describe('MenuModal: automatic geolocation has a time budget', () => {
  it('a hanging address lookup ends as "not checked" (checkout allowed) instead of loading for minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.search.mockImplementation(() => new Promise(() => undefined));

      render(
        <MenuModal
          isOpen
          onClose={vi.fn()}
          orderType="delivery"
          selectedCustomer={customer}
          selectedAddress={canonicalAddressWithoutPoint()}
        />,
      );

      await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('fee-status')).toHaveTextContent('loading');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });
      await waitFor(() => expect(screen.getByTestId('fee-status')).toHaveTextContent('not_checked'));
      expect(mocks.validateAddress).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Review finding (2026-09-29): with the address re-pick stacked over the
// menu, the menu's "type to search" handler moved the first keystroke into
// the hidden menu search behind it.
describe('MenuModal: keystrokes with a dialog stacked over the menu', () => {
  function renderMenu() {
    mocks.search.mockResolvedValue([]);
    return render(
      <MenuModal
        isOpen
        onClose={vi.fn()}
        orderType="delivery"
        selectedCustomer={customer}
        selectedAddress={canonicalAddressWithoutPoint()}
      />,
    );
  }

  it('control: with the menu on top, a printable key jumps to the menu search', async () => {
    renderMenu();
    const search = await screen.findByPlaceholderText('Search menu items...');
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: '2' });
    expect(document.activeElement).toBe(search);
  });

  it('with another dialog on top, the key stays there', async () => {
    const view = renderMenu();
    const search = await screen.findByPlaceholderText('Search menu items...');
    view.rerender(
      <>
        <MenuModal
          isOpen
          onClose={vi.fn()}
          orderType="delivery"
          selectedCustomer={customer}
          selectedAddress={canonicalAddressWithoutPoint()}
        />
        <LiquidGlassModal isOpen onClose={vi.fn()} title="Edit address">
          <p>address editor</p>
        </LiquidGlassModal>
      </>,
    );
    const editor = await screen.findByRole('dialog', { name: 'Edit address' });
    editor.focus();
    fireEvent.keyDown(editor, { key: '2' });
    expect(document.activeElement).not.toBe(search);
    fireEvent.keyDown(document.body, { key: '7' });
    expect(document.activeElement).not.toBe(search);
  });

  it('isMenuTopMostDialog: only the top-most dialog, and never a key aimed at another dialog', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    menu.appendChild(input);
    document.body.appendChild(menu);
    try {
      expect(isMenuTopMostDialog(input)).toBe(true);
      const other = document.createElement('div');
      other.setAttribute('role', 'dialog');
      const button = document.createElement('button');
      other.appendChild(button);
      document.body.appendChild(other);
      expect(isMenuTopMostDialog(input)).toBe(false);
      document.body.removeChild(other);
      // A detached dialog node still counts when the key comes from it.
      expect(isMenuTopMostDialog(input, [button])).toBe(false);
      expect(isMenuTopMostDialog(input, [input])).toBe(true);
    } finally {
      document.body.removeChild(menu);
    }
  });
});
