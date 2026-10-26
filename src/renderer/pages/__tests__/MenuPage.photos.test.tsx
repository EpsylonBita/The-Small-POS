import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MenuPage from '../MenuPage';

const mocks = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>, loadItems: vi.fn(), clearCache: vi.fn(),
  handlers: new Map<string, () => void>(),
  cart: {} as any, createOrder: vi.fn(), fiscalActive: vi.fn(),
  getSetting: vi.fn(), searchParams: new URLSearchParams('customerName=A&customerPhone=123'),
}));
vi.mock('../../services/MenuService', () => ({ menuService: {
  getMenuItems: () => mocks.loadItems(),
  getMenuCategories: async () => [{ id: 'drinks', name: 'Drinks' }],
  clearCache: mocks.clearCache, getIngredients: async () => [],
} }));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ settings: { get: mocks.fiscalActive }, terminalConfig: { getBranchId: async () => 'branch-1' } }),
  onEvent: (event: string, handler: () => void) => mocks.handlers.set(event, handler),
  offEvent: (event: string) => mocks.handlers.delete(event),
}));
vi.mock('../../components/menu', () => ({
  MenuGrid: ({ items, onItemClick }: { items: Array<{ id: string; name: string; price: number; image?: string }>; onItemClick: (item: unknown) => void }) => <div>
    <button onClick={() => onItemClick(items[0])}>Choose item</button>
    {items.map(item => <div key={item.id}>{item.name}<span data-testid={`price-${item.id}`}>{item.price}</span>{item.image && <img src={item.image} alt={item.name} />}</div>)}
  </div>,
  MenuItemModal: ({ isOpen, menuItem, onAddToCart }: any) => isOpen
    ? <button onClick={() => onAddToCart(menuItem, 2, [], '')}>Add item</button> : null,
  CartSummary: (props: any) => { mocks.cart = props; return null; }, MenuCategoryTabs: () => null,
}));
vi.mock('../../hooks/useOrderStore', () => ({ useOrderStore: () => ({ createOrder: mocks.createOrder, isOperationLoading: false }) }));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../hooks/useTerminalSettings', () => ({ useTerminalSettings: () => ({ getSetting: mocks.getSetting }) }));
vi.mock('../../hooks/useFeaturedItems', () => ({ useFeaturedItems: () => ({ topSellerIds: new Set() }) }));
vi.mock('../../components/modals/CustomerInfoModal', () => ({ CustomerInfoModal: () => null }));
vi.mock('../../components/skeletons', () => ({ MenuPageSkeleton: () => null }));
vi.mock('../../components/error', () => ({ ErrorDisplay: () => null }));
vi.mock('../../components/ui/page-motion', () => ({ pageMotionContainer: {}, pageMotionItem: {} }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [mocks.searchParams] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('framer-motion', () => ({ motion: { div: ({ children }: React.PropsWithChildren) => <div>{children}</div> } }));

const photo = 'https://images.example.test/coffee.jpg';
const row = { id: 'coffee', category_id: 'drinks', name: 'Coffee', price: 3, image_url: photo };
beforeEach(() => {
  mocks.items = [row];
  mocks.getSetting.mockReset().mockReturnValue(undefined);
  mocks.fiscalActive.mockReset().mockResolvedValue(false);
  mocks.createOrder.mockReset().mockResolvedValue({ success: true });
  mocks.handlers.clear();
  mocks.loadItems.mockReset().mockImplementation(async () => mocks.items);
});
afterEach(cleanup);

describe('mounted Windows ordering screen after durable photo sync', () => {
  it('submits the same Swiss item prices, category and discount used by its cart, with the native fiscal gate', async () => {
    mocks.items = [{ ...row, id: '10000000-0000-4000-8000-000000000001', price: 6.5,
      pickup_price: 6.5, vat_category_code: 'ch_reduced_26', price_includes_vat: true }];
    mocks.getSetting.mockImplementation((category: string, key: string) => ({
      'tax.vat_country': 'CH', 'tax.vat_default_category_code': 'ch_standard_81',
      'tax.vat_print_on_receipt': false,
    } as Record<string, unknown>)[`${category}.${key}`]);
    mocks.fiscalActive.mockResolvedValue(true);
    render(<MenuPage />);
    await waitFor(() => expect(mocks.cart.slipsPrintVat).toBe(true));
    // The mocked grid renders "Choose item" before the menu loads; clicking it
    // then opens no item and "Add item" never appears (CI flake, PR #380).
    await screen.findByText('Coffee');
    fireEvent.click(screen.getByRole('button', { name: 'Choose item' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add item' }));
    expect(mocks.cart.cartItems[0]).toMatchObject({
      unitPrice: 6.5, totalPrice: 13, quantity: 2, vatCategoryCode: 'ch_reduced_26',
    });
    expect(mocks.cart.vatSettings.country).toBe('CH');
    await act(async () => mocks.cart.onPlaceOrder(1.3));
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      total_amount: 11.7, subtotal: 13, discount_amount: 1.3,
      items: [expect.objectContaining({ quantity: 2, unit_price: 6.5, total_price: 13,
        vat_category_code: 'ch_reduced_26', price_includes_vat: true })],
    }));
  });
  it('reloads the saved projection and removes a photo without removing Coffee', async () => {
    render(<MenuPage />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'Coffee' })).toHaveAttribute('src', photo));
    mocks.items = [{ ...row, image_url: null, show_image_in_pos: false }];
    await act(async () => mocks.handlers.get('menu:sync')!());
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Coffee' })).toBeNull());
    expect(screen.getByText('Coffee')).toBeVisible();
    expect(mocks.clearCache).toHaveBeenCalled();
  });

  it('does not let an older in-flight snapshot restore a removed photograph', async () => {
    let releaseOld!: (items: Array<Record<string, unknown>>) => void;
    mocks.loadItems.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }));
    render(<MenuPage />);
    await waitFor(() => expect(releaseOld).toBeDefined());
    mocks.items = [{ ...row, image_url: null, show_image_in_pos: false }];
    await act(async () => mocks.handlers.get('menu:sync')!());
    await waitFor(() => expect(screen.getByText('Coffee')).toBeVisible());
    await act(async () => releaseOld([row]));
    expect(screen.queryByRole('img', { name: 'Coffee' })).toBeNull();
  });
});

// POS audit K4: the native menu rows arrive with the branch's overrides merged,
// so the grid shows the row as served; nothing swaps a price for display.
describe('branch overrides on the ordering screen', () => {
  it('prices the merged row as the native menu serves it', async () => {
    mocks.items = [{
      ...row, price: 2.5, base_price: 2.5, pickup_price: 2.5, delivery_price: 2.5, dine_in_price: 2.5,
      price_overridden: true, catalog_prices: { price: 3, pickup_price: 3 },
    }];
    render(<MenuPage />);
    await waitFor(() => expect(screen.getByTestId('price-coffee')).toHaveTextContent('2.5'));
  });

  it('shows the catalog price again once the override is gone', async () => {
    mocks.items = [{ ...row, price: 2.5, pickup_price: 2.5, price_overridden: true }];
    render(<MenuPage />);
    await waitFor(() => expect(screen.getByTestId('price-coffee')).toHaveTextContent('2.5'));
    mocks.items = [{ ...row, price: 3, pickup_price: 3 }];
    await act(async () => mocks.handlers.get('menu:sync')!());
    await waitFor(() => expect(screen.getByTestId('price-coffee')).toHaveTextContent('3'));
  });
});
