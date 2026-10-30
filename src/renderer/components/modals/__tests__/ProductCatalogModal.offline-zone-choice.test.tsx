import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Offline week Ω6β in the retail catalogue (delivery of goods): offline, a
// saved address whose Google point expired (FIX-03, 28 days) gets its zone
// from the cashier; the chosen zone's fee and the "zone chosen manually"
// marker reach the order. Never fee 0 without that choice. Synthetic data.

const mocks = vi.hoisted(() => ({
  offline: true,
  complete: vi.fn(),
  error: vi.fn(),
  validate: vi.fn(),
  search: vi.fn(async () => []),
  getDeliveryZones: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options: any) =>
  typeof options === 'string' ? options : options?.defaultValue ?? key }) }));
vi.mock('react-hot-toast', () => ({ default: { error: mocks.error } }));
vi.mock('../../../utils/format', () => ({ formatCurrency: (value: number) => value.toFixed(2) }));
vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('../../../contexts/cashier-gate-context', () => ({ useCashierOperationsLocked: () => false }));
vi.mock('../../../contexts/module-context', () => ({ useModules: () => ({ organizationId: 'o1' }) }));
const product = { id: 'p1', name: 'Water', price: 4, quantity: 10, isActive: true, unitOfMeasure: 'pcs', soldByMeasure: false, variants: [] };
vi.mock('../../../hooks/useProductCatalog', () => ({ useProductCatalog: () => ({ products: [product], categories: [], isLoading: false, scanBarcode: vi.fn() }) }));
vi.mock('../../../hooks/useDiscountSettings', () => ({ useDiscountSettings: () => ({ maxDiscountPercentage: 50, unavailable: false, refreshSettings: vi.fn() }) }));
vi.mock('../../../hooks/useDeliveryValidation', () => ({ useDeliveryValidation: () => ({ validateAddress: mocks.validate, isValidating: false }) }));
vi.mock('../../../hooks/useAcquiredModules', () => ({
  useAcquiredModules: () => ({ hasModule: () => true }),
  MODULE_IDS: { DELIVERY: 'delivery', DELIVERY_ZONES: 'delivery_zones' },
}));
vi.mock('../../../contexts/barcode-scanner-context', () => ({
  useBarcodeScannerContext: () => ({ state: { isScanning: false } }),
  useOnBarcodeScan: () => undefined,
}));
// One bridge, as the till's getBridge() singleton. A new object per call
// changed `bridge.customers` on every render, which re-ran the address lookup
// and hid the zone choice for a moment (nightly Full Regression, 30/10/2026).
vi.mock('../../../../lib', () => {
  const bridge = {
    settings: { getLocal: async () => ({}), get: async () => null },
    branchData: { getDeliveryZones: mocks.getDeliveryZones },
    customers: { updateAddress: vi.fn() },
  };
  return {
    getBridge: () => bridge,
    onEvent: vi.fn(),
    offEvent: vi.fn(),
  };
});
vi.mock('../../../services/server-reachability', () => ({
  isTillKnownOffline: () => mocks.offline,
  subscribeServerReachability: () => () => undefined,
}));
vi.mock('../../../services/address-workflow', async () => {
  const houseNumber = await import('../../../services/address-house-number');
  return {
    ...houseNumber,
    createAddressSessionToken: () => 'addr_session_test',
    searchAddressSuggestions: mocks.search,
    resolveAddressSuggestion: vi.fn(),
  };
});
vi.mock('../../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => ({ branchId: 'b1', organizationId: 'o1' }), refreshTerminalCredentialCache: async () => ({ branchId: 'b1', organizationId: 'o1' }) }));
vi.mock('../../../hooks/useScale', () => ({ useScale: () => ({ readWeight: vi.fn() }) }));
vi.mock('../../../utils/catalog-offers', () => ({ isOfferRewardLine: () => false, mapRewardActionsWithSignatures: () => [], validateCatalogOffers: async () => null }));
vi.mock('../../ui/pos-glass-components', () => ({ LiquidGlassModal: ({ isOpen, title, children }: any) => isOpen ? <section aria-label={title}>{children}</section> : null }));
vi.mock('../PaymentModal', () => ({ PaymentModal: ({ isOpen, onPaymentComplete }: any) => isOpen ? <button onClick={() => onPaymentComplete({ method: 'cash' })}>Confirm payment</button> : null }));

import { ProductCatalogModal } from '../ProductCatalogModal';
import { deliveryZoneSelectionMetadata } from '../../../utils/delivery-fee';

const expiredAddress = {
  id: 'addr-1',
  street_address: 'Odos Dokimis 12',
  city: 'Kalamaria',
  postal_code: '55133',
  coordinate_source: 'google',
  google_place_id: 'place-test-1',
  geocoded_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  latitude: 40.5836,
  longitude: 22.9502,
};

const modal = (address = expiredAddress) => (
  <ProductCatalogModal
    isOpen
    onClose={() => {}}
    orderType="delivery"
    selectedCustomer={{ id: 'c1', name: 'Customer' }}
    selectedAddress={address}
    onOrderComplete={mocks.complete}
  />
);
const show = () => render(modal());

beforeEach(() => {
  vi.clearAllMocks();
  mocks.offline = true;
  mocks.complete.mockResolvedValue(true);
  mocks.getDeliveryZones.mockResolvedValue({
    success: true,
    data: { zones: [{ id: 'zone-b', name: 'Zone B', delivery_fee: 2.5, minimum_order_amount: 0, is_active: true }] },
  });
});
afterEach(cleanup);

describe('retail delivery offline, saved address with an expired Google point', () => {
  it('waits for the cashier to choose the zone, then sends its fee and the marker', async () => {
    const view = show();
    fireEvent.click(await screen.findByText('Water'));
    const option = await screen.findByTestId('offline-zone-option-zone-b');
    expect(screen.getByText('menu.cart.deliveryFeeChooseZone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checkout' })).toBeDisabled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();

    // The fee and the "zone chosen manually" marker come in the same render.
    fireEvent.click(option);
    const picker = screen.getByTestId('offline-zone-picker');
    expect(within(picker).getByText('menu.cart.zoneChosenManually')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checkout' })).toBeEnabled();

    // The parent rebuilds the address object on every render. The choice stays
    // in force: the address is not looked up again, so the picker and its
    // marker never leave the screen and Checkout stays enabled.
    view.rerender(modal({ ...expiredAddress }));
    expect(picker).toBeInTheDocument();
    expect(within(picker).getByText('menu.cart.zoneChosenManually')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checkout' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm payment' }));
    await waitFor(() => expect(mocks.complete).toHaveBeenCalled());
    const order = mocks.complete.mock.calls[0][0];
    expect(order.deliveryFee).toBe(2.5);
    expect(deliveryZoneSelectionMetadata(null, 'delivery', order.deliveryZoneInfo)).toMatchObject({
      delivery_zone_selection: { source: 'manual', zone_id: 'zone-b', delivery_fee: 2.5 },
    });
  });

  it('online it is unchanged: no zone choice', async () => {
    mocks.offline = false;
    show();
    fireEvent.click(await screen.findByText('Water'));
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    expect(screen.queryByTestId('offline-zone-picker')).toBeNull();
  });
});
