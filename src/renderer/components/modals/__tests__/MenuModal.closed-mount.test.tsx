import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Render-instrumentation probe for the shared modal shell. The mock preserves
// the REAL LiquidGlassModal behavior while recording each render's isOpen.
// Closed-mount guarantee under test: while MenuModal has isOpen=false it
// early-returns null, so LiquidGlassModal must never render at all.
const { lgmRenderSpy } = vi.hoisted(() => ({ lgmRenderSpy: vi.fn() }));

vi.mock('../../ui/pos-glass-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui/pos-glass-components')>();
  const ActualLiquidGlassModal = actual.LiquidGlassModal;
  const LiquidGlassModal: typeof actual.LiquidGlassModal = (props) => {
    lgmRenderSpy(props.isOpen);
    return <ActualLiquidGlassModal {...props} />;
  };
  return { ...actual, LiquidGlassModal };
});

// `t` MUST be referentially stable across renders (as react-i18next's is):
// MenuModal's menu-items loader effect lists `t` in its dependency array and
// sets a fresh array each run, so a per-render `t` identity loops the
// component into OOM.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const translation = {
    t: (key: string, fallback?: string | { defaultValue?: string }) => (
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
    ),
  };
  return {
    ...actual,
    useTranslation: () => translation,
  };
});

vi.mock('../../../contexts/i18n-context', () => {
  const i18n = {
    language: 'en',
    setLanguage: vi.fn(),
    t: (key: string) => (key === 'common.actions.close' ? 'Close' : key),
  };
  return { useI18n: () => i18n };
});

// Hook mocks MUST return referentially stable values: several MenuModal
// effects/memos list these results in their dependency arrays, and a mock
// that fabricates fresh objects per render re-arms them on every commit.
vi.mock('../../../contexts/shift-context', () => {
  const shiftValue = {
    staff: { branchId: 'branch-1' },
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
  const value = {
    validateAddress: vi.fn(async () => null),
    isValidating: false,
  };
  return { useDeliveryValidation: () => value };
});

vi.mock('../../../hooks/useAcquiredModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useAcquiredModules')>();
  const value = { hasModule: () => false };
  return {
    ...actual,
    useAcquiredModules: () => value,
  };
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
  getCachedTerminalCredentials: vi.fn(() => null),
  refreshTerminalCredentialCache: vi.fn(async () => null),
}));

vi.mock('../../../utils/api-helpers', () => ({
  posApiGet: vi.fn(async () => ({ success: false })),
  posApiPost: vi.fn(async () => ({ success: false })),
}));

vi.mock('../../../utils/catalog-offers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/catalog-offers')>()),
  validateCatalogOffers: vi.fn(async () => null),
}));

// The real getBridge() returns a stable singleton, and MenuModal depends on
// that: `bridge.loyalty` sits in an effect dependency array, so a mock that
// fabricates a fresh bridge per call re-arms that effect on every render and
// loops the component. Partial mock; the rest of src/lib stays real.
vi.mock('../../../../lib', async (importOriginal) => {
  const bridge = {
    settings: { get: vi.fn(async () => null) },
    orders: { getById: vi.fn(async () => null) },
    customers: {},
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

// Presentation-heavy children are not under test; stub them so the shell
// gating is exercised without dragging their own data dependencies in.
vi.mock('../../menu/MenuCategoryTabs', () => ({
  MenuCategoryTabs: () => <div data-testid="menu-category-tabs" />,
}));
vi.mock('../../menu/MenuItemGrid', () => ({
  MenuItemGrid: ({ onQuickAdd }: any) => (
    <div data-testid="menu-item-grid">
      <button onClick={() => onQuickAdd({
        id: 'espresso', name: 'Espresso', category_id: 'coffee',
        price: 8, pickup_price: 3, delivery_price: 4,
      }, 2)}>Add espresso</button>
    </div>
  ),
}));
vi.mock('../../menu/MenuCart', () => ({
  MenuCart: ({ cartItems, onRemoveItem, onEditItem }: any) => (
    <div data-testid="menu-cart">
      {cartItems.map((item: any) => (
        <div key={item.id}>
          <span>{item.name} × {item.quantity} = {item.totalPrice} [{item.categoryName || ''}]</span>
          <span data-testid="cart-customizations">{JSON.stringify(item.customizations)}</span>
          <button onClick={() => onRemoveItem(item.id)}>Remove {item.name}</button>
          <button onClick={() => onEditItem(item)}>Edit {item.name}</button>
        </div>
      ))}
    </div>
  ),
}));
vi.mock('../../menu/MenuItemModal', () => ({
  MenuItemModal: ({ menuItem, onAddToCart }: any) => (
    <button onClick={() => onAddToCart(menuItem, 3, [], 'edited')}>Save edited item</button>
  ),
}));
vi.mock('../../menu/ComboChoiceModal', () => ({
  ComboChoiceModal: () => null,
}));
vi.mock('../PaymentModal', () => ({
  PaymentModal: () => null,
}));
vi.mock('../LoyaltyRedeemModal', () => ({
  LoyaltyRedeemModal: () => null,
}));

import { MenuModal } from '../MenuModal';
import { menuService } from '../../../services/MenuService';

const baseProps = {
  onClose: vi.fn(),
  orderType: 'pickup' as const,
};

describe('MenuModal closed-state mount gating', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('contributes no vDOM while closed: LiquidGlassModal never renders, across repeated parent renders', () => {
    const view = render(<MenuModal {...baseProps} isOpen={false} />);

    // OrderDashboard mounts this modal twice, unconditionally, and re-renders
    // constantly at an idle dashboard; a closed instance must stay inert.
    for (let i = 0; i < 5; i += 1) {
      view.rerender(<MenuModal {...baseProps} isOpen={false} />);
    }

    expect(lgmRenderSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the menu surface when opened and drops it entirely on a parent-driven close', async () => {
    const view = render(<MenuModal {...baseProps} isOpen={false} />);
    expect(lgmRenderSpy).not.toHaveBeenCalled();

    view.rerender(<MenuModal {...baseProps} isOpen />);
    expect(lgmRenderSpy.mock.calls.some(([open]) => open === true)).toBe(true);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByTestId('menu-cart')).toBeInTheDocument();

    // Parent-driven close: the early return unmounts the shell immediately
    // (accepted snap-close, same as OrderDetailsModal).
    lgmRenderSpy.mockClear();
    view.rerender(<MenuModal {...baseProps} isOpen={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lgmRenderSpy).not.toHaveBeenCalled();
  });
});

describe('MenuModal stored customization metadata', () => {
  afterEach(cleanup);
  it('keeps actual ingredients while ignoring _meta when reopening an order', async () => {
    render(<MenuModal {...baseProps} isOpen editMode editOrderId="qa-meta" initialCartItems={[
      { id: 'coffee', name: 'Espresso', quantity: 1, price: 4, customizations: {
        milk: { ingredient: { id: 'milk', name: 'Milk', price: 0 }, quantity: 1 },
        _meta: { product_name: 'Espresso', category_id: null, line_kind: 'item' },
      } },
    ]} />);
    await waitFor(() => expect(screen.getByTestId('cart-customizations')).toHaveTextContent('Milk'));
    expect(screen.getByTestId('cart-customizations')).not.toHaveTextContent('Unknown');
    expect(screen.getByTestId('cart-customizations')).not.toHaveTextContent('product_name');
  });
});

describe('MenuModal immediate product taps', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(menuService.getMenuCategories).mockReset().mockResolvedValue([]);
    vi.mocked(menuService.getMenuItemById).mockReset().mockResolvedValue(null);
  });

  it('shows the priced item before slow categories arrive, then fills its label without another request', async () => {
    let resolveCategories!: (value: any[]) => void;
    vi.mocked(menuService.getMenuCategories).mockReturnValue(new Promise((resolve) => {
      resolveCategories = resolve;
    }));
    render(<MenuModal {...baseProps} isOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Add espresso' }));
    expect(screen.getByText('Espresso × 2 = 6 []')).toBeInTheDocument();
    expect(menuService.getMenuCategories).toHaveBeenCalledTimes(1);

    await act(async () => { resolveCategories([{ id: 'coffee', name: 'Coffee' }]); });
    expect(screen.getByText('Espresso × 2 = 6 [Coffee]')).toBeInTheDocument();
  });

  it('does not resurrect a removed item when category loading finishes', async () => {
    let resolveCategories!: (value: any[]) => void;
    vi.mocked(menuService.getMenuCategories).mockReturnValue(new Promise((resolve) => {
      resolveCategories = resolve;
    }));
    render(<MenuModal {...baseProps} isOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Add espresso' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Espresso' }));
    await act(async () => { resolveCategories([{ id: 'coffee', name: 'Coffee' }]); });
    expect(screen.getByTestId('menu-cart')).not.toHaveTextContent('Espresso');
  });

  it('ignores categories from a closed session after the menu reopens', async () => {
    let resolveOldCategories!: (value: any[]) => void;
    vi.mocked(menuService.getMenuCategories)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldCategories = resolve; }))
      .mockResolvedValue([{ id: 'coffee', name: 'Current coffee' }] as any);
    const view = render(<MenuModal {...baseProps} isOpen />);
    view.rerender(<MenuModal {...baseProps} isOpen={false} />);
    view.rerender(<MenuModal {...baseProps} isOpen />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Add espresso' }));
    await act(async () => { resolveOldCategories([{ id: 'coffee', name: 'Obsolete coffee' }]); });
    fireEvent.click(screen.getByRole('button', { name: 'Add espresso' }));
    expect(screen.getAllByText('Espresso × 2 = 6 [Current coffee]')).toHaveLength(2);
    expect(screen.getByTestId('menu-cart')).not.toHaveTextContent('Obsolete');
  });

  it('keeps the edited quantity and price when late categories enrich the replacement row', async () => {
    let resolveCategories!: (value: any[]) => void;
    vi.mocked(menuService.getMenuCategories).mockReturnValue(new Promise((resolve) => {
      resolveCategories = resolve;
    }));
    vi.mocked(menuService.getMenuItemById).mockResolvedValue({
      id: 'espresso', name: 'Espresso', category_id: 'coffee', price: 8, pickup_price: 3,
    });
    render(<MenuModal {...baseProps} isOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Add espresso' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Espresso' }));
    // This child stub renders inline instead of in its real modal portal.
    fireEvent.click(await screen.findByRole('button', { name: 'Save edited item', hidden: true }));
    expect(screen.getByText('Espresso × 3 = 9 []')).toBeInTheDocument();
    await act(async () => { resolveCategories([{ id: 'coffee', name: 'Coffee' }]); });
    expect(screen.getByText('Espresso × 3 = 9 [Coffee]')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove Espresso' })).toHaveLength(1);
  });
});
