import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Item H, fix review 30/09/2026 (the same decision as Android). While the
// store's discount cap cannot be read, the order menu used to cap discounts
// on an assumed 30% and go on to payment. Now checkout pauses with a clear
// message and "Try again", and no discount is allowed on an assumed cap.

const mocks = vi.hoisted(() => ({
  settings: {
    maxDiscountPercentage: 30,
    unavailable: true,
    refreshSettings: vi.fn(async () => undefined),
  },
  toastError: vi.fn(),
  cartMaxDiscount: [] as number[],
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: mocks.toastError,
    dismiss: vi.fn(),
  }),
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
    staff: { branchId: 'branch-1' },
    activeShift: null,
    isShiftActive: false,
    refreshActiveShift: vi.fn(async () => undefined),
  };
  return { useShift: () => shiftValue };
});

vi.mock('../../../hooks/useDiscountSettings', () => ({
  useDiscountSettings: () => mocks.settings,
}));

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
  const value = { validateAddress: vi.fn(), isValidating: false };
  return { useDeliveryValidation: () => value };
});

vi.mock('../../../hooks/useAcquiredModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useAcquiredModules')>();
  const value = { hasModule: () => false };
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
  getCachedTerminalCredentials: vi.fn(() => ({ branchId: 'branch-1' })),
  refreshTerminalCredentialCache: vi.fn(async () => ({ branchId: 'branch-1' })),
}));

vi.mock('../../../utils/api-helpers', () => ({
  posApiGet: vi.fn(async () => ({ success: false })),
  posApiPost: vi.fn(async () => ({ success: false })),
}));

vi.mock('../../../utils/catalog-offers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/catalog-offers')>()),
  validateCatalogOffers: vi.fn(async () => null),
}));

vi.mock('../../../../lib', async (importOriginal) => {
  const bridge = {
    settings: { get: vi.fn(async () => null) },
    orders: { getById: vi.fn(async () => null) },
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
      id: 'espresso', name: 'Espresso', category_id: 'coffee', price: 8, pickup_price: 8,
    }, 1)}>Add espresso</button>
  ),
}));
vi.mock('../../menu/MenuCart', () => ({
  MenuCart: ({ onCheckout, maxDiscountPercentage }: any) => {
    mocks.cartMaxDiscount.push(maxDiscountPercentage);
    return (
      <div data-testid="menu-cart">
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

import { MenuModal } from '../MenuModal';

const customer = { id: 'customer-1', name: 'Test Customer', phone: '6900000000' };

const renderMenu = () =>
  render(
    <MenuModal
      isOpen
      onClose={vi.fn()}
      orderType="pickup"
      selectedCustomer={customer}
    />,
  );

beforeEach(() => {
  mocks.settings.unavailable = true;
  mocks.settings.maxDiscountPercentage = 30;
  mocks.settings.refreshSettings.mockClear();
  mocks.toastError.mockReset();
  mocks.cartMaxDiscount.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('MenuModal when the store discount cap cannot be read', () => {
  it('pauses checkout with a message and Try again, and allows no discount on an assumed cap', async () => {
    renderMenu();

    fireEvent.click(await screen.findByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('payment-modal')).toBeNull();
    expect(mocks.cartMaxDiscount.at(-1)).toBe(0);
  });

  it('goes on to payment once the cap is read', async () => {
    mocks.settings.unavailable = false;
    renderMenu();

    fireEvent.click(await screen.findByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));

    await waitFor(() => expect(screen.getByTestId('payment-modal')).toBeTruthy());
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.cartMaxDiscount.at(-1)).toBe(30);
  });
});
