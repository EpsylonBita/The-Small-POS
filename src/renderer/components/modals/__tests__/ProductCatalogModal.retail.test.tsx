import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({
  products: [] as any[], scan: vi.fn(), readWeight: vi.fn(), complete: vi.fn(), error: vi.fn(),
  settings: {} as any, unsynced: [] as any[],
  globalScan: undefined as undefined | ((barcode: string) => Promise<void>),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options: any) =>
  typeof options === 'string' ? options : String(options?.defaultValue ?? key)
    .replace(/{{(\w+)}}/g, (_match: string, name: string) => String(options?.[name] ?? '')) }) }));
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
vi.mock('../../../../lib', () => ({
  getBridge: () => ({ settings: { getLocal: async () => mocks.settings },
    orders: { getUnsyncedRetailQuantities: async () => ({ success: true, quantities: mocks.unsynced }) } }),
  isBrowser: () => false, onEvent: vi.fn(), offEvent: vi.fn(),
}));
vi.mock('../../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => ({ branchId: 'b1', organizationId: 'o1' }), refreshTerminalCredentialCache: async () => ({ branchId: 'b1', organizationId: 'o1' }) }));
vi.mock('../../../hooks/useScale', () => ({ useScale: () => ({ readWeight: mocks.readWeight }) }));
vi.mock('../../../utils/catalog-offers', () => ({ isOfferRewardLine: () => false, mapRewardActionsWithSignatures: () => [], validateCatalogOffers: async () => null }));
vi.mock('../../ui/pos-glass-components', () => ({ LiquidGlassModal: ({ isOpen, title, children }: any) => isOpen ? <section aria-label={title}>{children}</section> : null }));
vi.mock('../PaymentModal', () => ({ PaymentModal: ({ isOpen, onPaymentComplete }: any) => isOpen ? <button onClick={() => onPaymentComplete({ method: 'cash' })}>Confirm payment</button> : null }));
import { ProductCatalogModal } from '../ProductCatalogModal';
import { resetRetailStockGuardCache } from '../../../services/retail-stock-guard';
import { RETAIL_STOCK_PARITY_CASES } from '../../../../../../shared/retail-stock.parity-cases';
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
  vi.clearAllMocks(); mocks.products = [product]; mocks.settings = {}; mocks.unsynced = [];
  mocks.complete.mockResolvedValue(true);
  resetRetailStockGuardCache();
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

// retail.block_overselling: the shared parity cases through the modal's add and edit paths.
const parity = (name: string) => RETAIL_STOCK_PARITY_CASES.find(testCase => testCase.name === name)!;
const shampoo = (stock: number, extra: Record<string, unknown> = {}) => ({
  id: 'product-shampoo', name: 'Shampoo', price: 8, quantity: stock, isActive: true, unitOfMeasure: 'piece', soldByMeasure: false, variants: [], ...extra,
});
const cartCount = (count: number) => screen.getByText(`Cart (${count})`);
const stepButton = (icon: 'plus' | 'minus') => document.querySelector(`svg.lucide-${icon}`)!.closest('button')!;
async function openBlocking() {
  mocks.settings = { retail: { block_overselling: true } };
  const view = show();
  await act(async () => {});
  return view;
}

describe('retail.block_overselling through the modal paths', () => {
  it('refuses a base product at zero stock', async () => {
    expect(parity('base product at zero stock is refused').expected.blocked).toBe(true);
    mocks.products = [shampoo(0)];
    await openBlocking();
    fireEvent.click(screen.getByText('Shampoo'));
    expect(mocks.error).toHaveBeenCalledWith('Only 0 pcs in stock');
    expect(cartCount(0)).toBeTruthy();
  });

  it('refuses a one-unit variant the second time, from the picker and from a scan', async () => {
    expect(parity('a one-unit variant added a second time is refused').expected).toMatchObject({ blocked: true, available: 1 });
    const withVariant = shampoo(5, { variants: [{ id: 'variant-shampoo-500', productId: 'product-shampoo', name: '500 ml', quantity: 1, priceAdjustment: 2, isActive: true }] });
    mocks.products = [withVariant];
    await openBlocking();
    fireEvent.click(screen.getByText('Shampoo'));
    fireEvent.click(await screen.findByRole('button', { name: /500 ml/ }));
    expect(cartCount(1)).toBeTruthy();
    fireEvent.click(screen.getByText('Shampoo'));
    expect(await screen.findByRole('button', { name: /500 ml/ })).toBeDisabled();
    mocks.scan.mockResolvedValue({ product: withVariant, embedded: null, variantId: 'variant-shampoo-500' });
    await act(async () => { await mocks.globalScan!('variant-barcode'); });
    expect(mocks.error).toHaveBeenCalledWith('Only 1 pcs in stock');
  });

  it('refuses a measured quantity above stock and keeps the line as it was', async () => {
    expect(parity('a measured quantity above stock is refused').expected.blocked).toBe(true);
    mocks.products = [{ ...product, quantity: 1.25 }];
    await openBlocking();
    fireEvent.click(screen.getByText('Rice'));
    const input = screen.getByRole('textbox', { name: 'Quantity' });
    fireEvent.change(input, { target: { value: '1.3' } });
    fireEvent.blur(input);
    expect(mocks.error).toHaveBeenCalledWith('Only 1.25 kg in stock');
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('1');
    fireEvent.change(input, { target: { value: '1.25' } });
    fireEvent.blur(input);
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('1.25');
  });

  it('refuses a scale label above what is left as a whole', async () => {
    expect(parity('a scale label above stock is refused whole').expected).toMatchObject({ blocked: true, available: 0.5 });
    mocks.products = [{ ...product, quantity: 2 }];
    await openBlocking();
    mocks.scan.mockResolvedValue({ product: { ...product, quantity: 2 }, embedded: { value_type: 'weight', weight: 1.5, price: null }, variantId: null });
    await act(async () => { await mocks.globalScan!('label-1'); });
    expect(cartCount(1)).toBeTruthy();
    mocks.scan.mockResolvedValue({ product: { ...product, quantity: 2 }, embedded: { value_type: 'weight', weight: 0.75, price: null }, variantId: null });
    await act(async () => { await mocks.globalScan!('label-2'); });
    expect(mocks.error).toHaveBeenCalledWith('Only 0.5 kg in stock');
    expect(cartCount(1)).toBeTruthy();
  });

  it('refuses a stable scale reading above stock without changing the line', async () => {
    mocks.products = [{ ...product, quantity: 1.25 }];
    await openBlocking();
    fireEvent.click(screen.getByText('Rice'));
    mocks.readWeight.mockResolvedValue({ weight: 1.3, unit: 'kg', stable: true, timestamp: new Date().toISOString() });
    fireEvent.click(screen.getByRole('button', { name: 'productCatalog.retailReadiness.readScale' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Only 1.25 kg in stock'));
    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('1');
  });

  it('counts rapid base and extra-barcode scans before React renders', async () => {
    const item = shampoo(1);
    mocks.products = [item];
    await openBlocking();
    mocks.scan.mockResolvedValue({ product: item, embedded: null, variantId: null });
    await act(async () => {
      await mocks.globalScan!('base-barcode');
      await mocks.globalScan!('extra-barcode');
    });
    expect(cartCount(1)).toBeTruthy();
    expect(mocks.error).toHaveBeenCalledWith('Only 1 pcs in stock');
  });

  it('always allows lowering a quantity, and refuses + beyond the stock left', async () => {
    expect(parity('lowering a quantity is always allowed').expected.blocked).toBe(false);
    mocks.products = [shampoo(3)];
    const { rerender } = await openBlocking();
    fireEvent.click(screen.getByText('Shampoo'));
    fireEvent.click(stepButton('plus'));
    fireEvent.click(stepButton('plus'));
    expect(screen.getByText('3')).toBeTruthy();
    mocks.products = [shampoo(0)];
    rerender(<ProductCatalogModal isOpen onClose={() => {}} onOrderComplete={mocks.complete} />);
    fireEvent.click(stepButton('minus'));
    expect(screen.getByText('2')).toBeTruthy();
    expect(mocks.error).not.toHaveBeenCalled();
    fireEvent.click(stepButton('plus'));
    expect(mocks.error).toHaveBeenCalledWith('Only 0 pcs in stock');
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('sells at zero stock as today when the setting is off', async () => {
    expect(parity('the setting off never blocks').expected.blocked).toBe(false);
    mocks.products = [shampoo(0)];
    show(); await act(async () => {});
    fireEvent.click(screen.getByText('Shampoo'));
    fireEvent.click(stepButton('plus'));
    expect(cartCount(1)).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("counts this till's unsynced sales against the stock", async () => {
    expect(parity("this till's unsynced sales reduce what is left").expected).toMatchObject({ blocked: true, available: 1 });
    mocks.products = [shampoo(3)];
    mocks.unsynced = [{ productId: 'product-shampoo', variantId: null, quantity: 2 }];
    await openBlocking();
    fireEvent.click(screen.getByText('Shampoo'));
    expect(cartCount(1)).toBeTruthy();
    fireEvent.click(stepButton('plus'));
    expect(mocks.error).toHaveBeenCalledWith('Only 1 pcs in stock');
  });

  it('checks stock once more before payment', async () => {
    mocks.products = [shampoo(2)];
    const { rerender } = await openBlocking();
    fireEvent.click(screen.getByText('Shampoo'));
    mocks.products = [shampoo(0)];
    rerender(<ProductCatalogModal isOpen onClose={() => {}} onOrderComplete={mocks.complete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Only 0 pcs in stock'));
    expect(screen.queryByRole('button', { name: 'Confirm payment' })).toBeNull();
  });
});
