import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({
  products: [] as any[], scan: vi.fn(), readWeight: vi.fn(), complete: vi.fn(), error: vi.fn(),
  settings: {} as any,
  globalScan: undefined as undefined | ((barcode: string) => Promise<void>),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options: any) =>
  typeof options === 'string' ? options : options?.defaultValue ?? key }) }));
vi.mock('react-hot-toast', () => ({ default: { error: mocks.error } }));
vi.mock('../../../utils/format', () => ({ formatCurrency: (value: number) => value.toFixed(2) }));
vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('../../../contexts/cashier-gate-context', () => ({ useCashierOperationsLocked: () => false }));
vi.mock('../../../contexts/module-context', () => ({ useModules: () => ({ organizationId: 'o1' }) }));
vi.mock('../../../hooks/useProductCatalog', () => ({ useProductCatalog: () => ({ products: mocks.products, categories: [], isLoading: false, scanBarcode: mocks.scan }) }));
vi.mock('../../../hooks/useDiscountSettings', () => ({ useDiscountSettings: () => ({ maxDiscountPercentage: 50, unavailable: false, refreshSettings: vi.fn() }) }));
vi.mock('../../../hooks/useDeliveryValidation', () => ({ useDeliveryValidation: () => ({ validateAddress: vi.fn(), isValidating: false }) }));
vi.mock('../../../hooks/useAcquiredModules', () => ({ useAcquiredModules: () => ({ hasModule: () => false }), MODULE_IDS: {} }));
vi.mock('../../../contexts/barcode-scanner-context', () => ({
  useBarcodeScannerContext: () => ({ state: { isScanning: false } }),
  useOnBarcodeScan: (callback: any) => { mocks.globalScan = callback; },
}));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ settings: { getLocal: async () => mocks.settings } }), onEvent: vi.fn(), offEvent: vi.fn() }));
vi.mock('../../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => ({ branchId: 'b1', organizationId: 'o1' }), refreshTerminalCredentialCache: async () => ({ branchId: 'b1', organizationId: 'o1' }) }));
vi.mock('../../../hooks/useScale', () => ({ useScale: () => ({ readWeight: mocks.readWeight }) }));
vi.mock('../../../utils/catalog-offers', () => ({ isOfferRewardLine: () => false, mapRewardActionsWithSignatures: () => [], validateCatalogOffers: async () => null }));
vi.mock('../../ui/pos-glass-components', () => ({ LiquidGlassModal: ({ isOpen, title, children }: any) => isOpen ? <section aria-label={title}>{children}</section> : null }));
vi.mock('../PaymentModal', () => ({ PaymentModal: ({ isOpen, onPaymentComplete }: any) => isOpen ? <button onClick={() => onPaymentComplete({ method: 'cash' })}>Confirm payment</button> : null }));
import { ProductCatalogModal } from '../ProductCatalogModal';
const product = { id: 'p1', name: 'Rice', price: 3, quantity: 10, isActive: true, unitOfMeasure: 'kg', soldByMeasure: true, variants: [] };
const variant = { id: 'v1', name: 'Brown', quantity: 0, priceAdjustment: 2, isActive: true };
const show = () => render(<ProductCatalogModal isOpen onClose={() => {}} onOrderComplete={mocks.complete} />);
async function finish() {
  fireEvent.click(screen.getByRole('button', { name: 'Checkout' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm payment' }));
  await waitFor(() => expect(mocks.complete).toHaveBeenCalled());
  return mocks.complete.mock.calls[0][0];
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.products = [product]; mocks.settings = {};
  mocks.complete.mockResolvedValue(true);
});
afterEach(cleanup);
describe('retail modal checkout wiring', () => {
  it('opens the active variant picker and allows zero stock when overselling is allowed', async () => {
    mocks.products = [{ ...product, variants: [variant] }]; show();
    fireEvent.click(await screen.findByText('Rice'));
    const option = await screen.findByRole('button', { name: /Brown/ });
    expect(option).toBeEnabled(); fireEvent.click(option);
    expect((await finish()).items[0]).toMatchObject({ retail_variant_id: 'v1', name: 'Rice - Brown', price: 5 });
  });
  it('blocks the zero-stock variant only under the explicit overselling block setting', async () => {
    mocks.settings = { retail: { block_overselling: true } };
    mocks.products = [{ ...product, variants: [variant] }]; show();
    await act(async () => {});
    fireEvent.click(screen.getByText('Rice'));
    expect(await screen.findByRole('button', { name: /Brown/ })).toBeDisabled();
  });
  it('scans a price label into a fractional order line retaining the printed total', async () => {
    mocks.scan.mockResolvedValue({ product, embedded: { value_type: 'price', price: 1, weight: null }, variantId: null });
    show(); await act(async () => { await mocks.globalScan!('label'); });
    const order = await finish();
    expect(order.items[0].quantity).toBe(0.333);
    expect(order.items[0].price * order.items[0].quantity).toBeCloseTo(1, 10);
    expect(order.total).toBeCloseTo(1, 10);
  });
  it('marks deposits explicitly and adds them after goods discounts', async () => {
    mocks.products = [{ ...product, soldByMeasure: false, price: 10, depositAmount: 2 }]; show();
    fireEvent.click(await screen.findByText('Rice'));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '50' } });
    const order = await finish();
    expect(order.items[0]).toMatchObject({ retail_product_id: 'p1', price: 10 });
    expect(order.items[1]).toMatchObject({ line_role: 'deposit', is_manual: true, price: 2 });
    expect(order.discountAmount).toBe(5);
    expect(order.total).toBe(7);
  });
  it('reads a fresh stable weight into the measured quantity; unstable readings leave it unchanged', async () => {
    show(); fireEvent.click(await screen.findByText('Rice'));
    const read = screen.getByRole('button', { name: 'productCatalog.retailReadiness.readScale' });
    mocks.readWeight.mockResolvedValue({ weight: 425, unit: 'g', stable: true, timestamp: new Date().toISOString() });
    fireEvent.click(read);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('0.425'));
    mocks.readWeight.mockResolvedValue({ weight: 0.9, unit: 'kg', stable: false, timestamp: new Date().toISOString() });
    fireEvent.click(read); await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('0.425');
  });
});
