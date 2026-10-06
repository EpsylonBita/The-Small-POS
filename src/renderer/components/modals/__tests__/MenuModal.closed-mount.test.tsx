import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCheckoutRequestId } from '../../../hooks/useCheckoutRequestId';

// Render-instrumentation probe for the shared modal shell. The mock preserves
// the REAL LiquidGlassModal behavior while recording each render's isOpen.
// Closed-mount guarantee under test: while MenuModal has isOpen=false it
// early-returns null, so LiquidGlassModal must never render at all.
const { lgmRenderSpy } = vi.hoisted(() => ({ lgmRenderSpy: vi.fn() }));
const { themeState } = vi.hoisted(() => ({ themeState: { resolvedTheme: 'light' } }));

vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => themeState }));

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
  refreshTerminalCredentialCache: vi.fn(async () => ({ branchId: 'branch-1', organizationId: 'org-1', terminalId: 'terminal-1' })),
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
const draftStorage = vi.hoisted(() => ({ draft: null as any, generation: 0, resumeError: null as string | null, inspection: { success: true, outcome: 'not_found', canCollect: false } as any }));
beforeEach(() => { draftStorage.draft = null; draftStorage.generation = 0; draftStorage.resumeError = null; draftStorage.inspection = { success: true, outcome: 'not_found', canCollect: false }; });
vi.mock('../../../../lib', async (importOriginal) => {
  const bridge = {
    invoke: vi.fn(async (command: string, input: any) => {
      if (command === 'checkout_draft_check_admission') return { success: true, currency: 'EUR' };
      if (command === 'checkout_draft_inspect') return draftStorage.inspection;
      if (command === 'checkout_draft_resume_declined') {
        if (draftStorage.resumeError) throw new Error(draftStorage.resumeError);
        if (input.expectedGeneration !== draftStorage.generation || input.clientRequestId !== draftStorage.draft.checkoutRequestId) throw new Error('CHECKOUT_DRAFT_VERSION_CHANGED');
        const { submission: _submission, ...editable } = draftStorage.draft;
        draftStorage.draft = { ...editable, phase: 'editing', checkoutRequestId: 'renewed-request',
          context: { ...editable.context, checkoutRequestId: 'renewed-request' } };
        draftStorage.generation++;
        draftStorage.inspection = { success: true, outcome: 'not_found', canCollect: false };
      }
      if (command === 'checkout_draft_put') { draftStorage.draft = input.draft; draftStorage.generation++; }
      if (command === 'checkout_draft_delete') { draftStorage.draft = null; draftStorage.generation++; }
      return { success: true, scope: { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'terminal-1' }, generation: draftStorage.generation, draft: draftStorage.draft };
    }),
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
  MenuCart: ({ cartItems, onRemoveItem, onEditItem, onCheckout, isSaving }: any) => (
    <div data-testid="menu-cart">
      <button onClick={onCheckout} disabled={isSaving}>Checkout</button>
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
  PaymentModal: ({ isOpen, onPaymentComplete, onSplitPayment, onClose }: any) => isOpen ? (
    <div>
      <button onClick={() => onPaymentComplete({ method: 'cash', amount: 6 })}>Pay cash</button>
      <button onClick={() => onSplitPayment(null)}>Split payment</button>
      <button onClick={onClose}>Back to menu</button>
    </div>
  ) : null,
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

describe('MenuModal pickup customer checkout', () => {
  afterEach(() => {
    cleanup();
    themeState.resolvedTheme = 'light';
  });

  const editCustomer = (name: string, phone: string, notes: string) => {
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: name } });
    fireEvent.change(screen.getByPlaceholderText('Phone'), { target: { value: phone } });
    fireEvent.change(screen.getByPlaceholderText('Notes'), { target: { value: notes } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', hidden: true }));
  };

  it.each(['Pay cash', 'Split payment'])('persists an anonymous pickup with %s', async (payment) => {
    const complete = vi.fn(async () => true);
    render(<MenuModal {...baseProps} isOpen selectedCustomer={null} onOrderComplete={complete} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Add Customer' }));
    editCustomer(' Alice ', ' 2101234567 ', ' Call on arrival ');
    const chip = screen.getByRole('button', { name: /Alice.*2101234567/ });
    expect(chip).toHaveClass('order-context-chip', 'order-context-chip--light');
    fireEvent.click(screen.getByRole('button', { name: 'Add espresso' }));
    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }));
    fireEvent.click(await screen.findByRole('button', { name: payment, hidden: true }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(complete.mock.calls[0][0]).toMatchObject({
      customer: { name: 'Alice', phone: '2101234567', phone_number: '2101234567', notes: 'Call on arrival' },
      notes: 'Call on arrival',
      orderType: 'pickup',
    });
    expect(complete.mock.calls[0][0].customer).not.toHaveProperty('id');
  });

  it.each(['Pay cash', 'Split payment'])('keeps the registered customer immutable and fields cleared with %s', async (payment) => {
    const customer = Object.freeze({ id: 'customer-1', name: 'Alice', full_name: 'Alice', phone: '111', phone_number: '111', notes: 'Old note' });
    const complete = vi.fn(async () => true);
    const view = render(<MenuModal {...baseProps} isOpen selectedCustomer={customer} onOrderComplete={complete} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Alice.*111/ }));
    editCustomer('', '', '');
    view.rerender(<MenuModal {...baseProps} isOpen selectedCustomer={{ ...customer }} onOrderComplete={complete} />);
    expect(screen.getByRole('button', { name: 'Add Customer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Alice.*111/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add espresso' }));
    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }));
    fireEvent.click(await screen.findByRole('button', { name: payment, hidden: true }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(complete.mock.calls[0][0]).toMatchObject({
      customer: { id: 'customer-1', name: '', full_name: '', phone: '', phone_number: '', notes: '' },
      notes: '',
    });
    expect(customer).toMatchObject({ name: 'Alice', phone: '111', notes: 'Old note' });
  });

  it('keeps pickup details after cancelling payment and reopening the saved cart', async () => {
    const view = render(<MenuModal {...baseProps} isOpen selectedCustomer={null} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Add Customer' }));
    editCustomer('Alice', '111', 'Call first');
    fireEvent.click(screen.getByRole('button', { name: 'Add espresso' }));
    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to menu', hidden: true }));
    fireEvent.click(await screen.findByRole('button', { name: /Alice.*111/ }));
    expect(screen.getByPlaceholderText('Notes')).toHaveValue('Call first');
    view.rerender(<MenuModal {...baseProps} isOpen={false} selectedCustomer={null} />);
    view.rerender(<MenuModal {...baseProps} isOpen selectedCustomer={null} />);
    await act(async () => {});
    expect(screen.queryByPlaceholderText('Name')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /Alice.*111/ }));
    expect(screen.getByPlaceholderText('Name')).toHaveValue('Alice');
    expect(screen.getByPlaceholderText('Phone')).toHaveValue('111');
    expect(screen.getByPlaceholderText('Notes')).toHaveValue('Call first');
  });

  it('resets for customer identity and edit-order changes without clobbering ongoing typing', () => {
    const customer = { id: 'customer-1', name: 'Alice', phone_number: '111', notes: 'Saved note' };
    const props = { ...baseProps, editMode: true, editOrderId: 'order-1', selectedCustomer: customer };
    const view = render(<MenuModal {...props} isOpen />);
    fireEvent.click(screen.getByRole('button', { name: /Alice.*111/ }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Typed name' } });
    view.rerender(<MenuModal {...props} isOpen selectedCustomer={{ ...customer }} />);
    expect(screen.getByPlaceholderText('Name')).toHaveValue('Typed name');
    view.rerender(<MenuModal {...props} isOpen editOrderId="order-2" />);
    expect(screen.getByPlaceholderText('Name')).toHaveValue('Alice');
    view.rerender(<MenuModal {...props} isOpen editOrderId="order-2" selectedCustomer={{ id: 'customer-2', name: 'Bob' }} />);
    expect(screen.getByPlaceholderText('Name')).toHaveValue('Bob');
    expect(screen.getByPlaceholderText('Phone')).toHaveValue('');
    view.rerender(<MenuModal {...props} isOpen editOrderId="order-2" selectedCustomer={null} />);
    expect(screen.getByPlaceholderText('Name')).toHaveValue('');
    expect(screen.getByPlaceholderText('Notes')).toHaveValue('');
  });

  it('uses the dark-theme foreground for a phone-only pickup chip', () => {
    themeState.resolvedTheme = 'dark';
    render(<MenuModal {...baseProps} isOpen selectedCustomer={{ phone: '111' }} />);
    expect(screen.getByRole('button', { name: '111' })).toHaveClass('order-context-chip', 'order-context-chip--dark');
  });
});


describe('MenuModal durable checkout recovery', () => {
  afterEach(cleanup);
  it('persists the exact frozen request before parent checkout and clears only its accepted cart', async () => {
    const complete = vi.fn(async (payload: any) => {
      expect(draftStorage.draft.phase).toBe('checkout_pending');
      expect(draftStorage.draft.checkoutRequestId).toBe(payload.clientRequestId);
      expect(draftStorage.draft.submission.items).toEqual(payload.items);
      return true;
    });
    render(<MenuModal {...baseProps} isOpen onOrderComplete={complete} />);
    await act(async () => {});
    fireEvent.click(screen.getByText('Add espresso')); fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Pay cash'));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(draftStorage.draft).toBeNull());
  });
  it('retains failed or ambiguous checkout across reopening and blocks another collection', async () => {
    const complete = vi.fn(async () => false);
    const props = { ...baseProps, isOpen: true, onOrderComplete: complete };
    const view = render(<MenuModal {...props} />); await act(async () => {});
    fireEvent.click(screen.getByText('Add espresso')); fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Pay cash')); await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await screen.findByText('The original checkout is retained. Confirm its result before starting another payment.');
    const retainedId = draftStorage.draft.checkoutRequestId;
    view.rerender(<MenuModal {...props} isOpen={false} />); view.rerender(<MenuModal {...props} />);
    await screen.findByText('The original checkout is retained. Confirm its result before starting another payment.');
    fireEvent.click(screen.getByText('Checkout')); expect(complete).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Check original checkout'));
    await act(async () => {});
    expect(draftStorage.draft.checkoutRequestId).toBe(retainedId);
    expect(draftStorage.draft.phase).toBe('checkout_pending');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0]).toEqual(complete.mock.calls[0][0]);
  });
  it('hydrates the actual saved form/cart after parent context restoration without an empty overwrite', async () => {
    draftStorage.draft = { schemaVersion: 1, draftId: 'restored-cart', checkoutRequestId: 'original-request', phase: 'editing',
      cartItems: [{ id: 'coffee', name: 'Espresso', quantity: 3, totalPrice: 9, customizations: [] }],
      context: { orderType: 'pickup', editMode: false, selectedCustomer: null, selectedAddress: null, tableNumber: '' },
      state: { pickupCustomerDraft: { name: 'Alex', phone: '123', notes: 'original note' }, manualDiscountValue: 2, manualDiscountMode: 'amount' } };
    const restore = vi.fn(); render(<MenuModal {...baseProps} isOpen onDraftRestore={restore} />);
    await screen.findByText('Espresso × 3 = 9 []');
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ checkoutRequestId: 'original-request', orderType: 'pickup' }));
    fireEvent.click(screen.getByRole('button', { name: /Alex.*123/ }));
    expect(screen.getByPlaceholderText('Notes')).toHaveValue('original note');
    expect(draftStorage.draft.cartItems).toHaveLength(1);
    expect(draftStorage.draft.checkoutRequestId).toBe('original-request');
  });
});


describe('MenuModal explicit immutable replay after crash before dispatch', () => {
  afterEach(cleanup);
  const editor = () => ({ schemaVersion: 1, draftId: 'frozen-edit', checkoutRequestId: 'edit-event', phase: 'checkout_pending',
    cartItems: [{ id: 'line', name: 'Coffee', quantity: 1, totalPrice: 4 }],
    context: { orderType: 'pickup', editMode: true, editOrderId: 'original-order', editExpectedVersion: 7 }, state: {},
    submission: { action: 'edit', orderId: 'original-order', client_event_id: 'edit-event', expected_version: 7, total: 4, items: [{ id: 'line', name: 'Coffee', quantity: 1, totalPrice: 4 }] } });
  it('replays a frozen edit with the exact original event/version and clears only after native acceptance', async () => {
    draftStorage.draft = editor();
    const complete = vi.fn(async (input: any) => {
      expect(input).toMatchObject({ orderId: 'original-order', client_event_id: 'edit-event', expected_version: 7 });
    });
    render(<MenuModal {...baseProps} isOpen editMode editOrderId="original-order" onEditComplete={complete} />);
    fireEvent.click(await screen.findByText('Check original checkout'));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1)); await waitFor(() => expect(draftStorage.draft).toBeNull());
  });
  it('fresh authorization can retry the same frozen edit after an uncertain denial without rebasing', async () => {
    draftStorage.draft = editor();
    draftStorage.inspection = { success: true, outcome: 'uncertain', canCollect: false, recovery: { recoveryState: 'auth_required' } };
    const complete = vi.fn().mockRejectedValueOnce(new Error('AUTHORIZATION_REQUIRED')).mockResolvedValue(undefined);
    render(<MenuModal {...baseProps} isOpen editMode editOrderId="original-order" onEditComplete={complete} />);
    fireEvent.click(await screen.findByText('Check original checkout'));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(draftStorage.draft.checkoutRequestId).toBe('edit-event');
    fireEvent.click(screen.getByText('Check original checkout'));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(complete.mock.calls[1][0]).toEqual(complete.mock.calls[0][0]);
    expect(complete.mock.calls[1][0]).toMatchObject({ client_event_id: 'edit-event', expected_version: 7, orderId: 'original-order' });
    await waitFor(() => expect(draftStorage.draft).toBeNull());
  });
  it('absence of a card reservation never permits new collection or erases the frozen cart', async () => {
    draftStorage.draft = { ...editor(), draftId: 'frozen-card', checkoutRequestId: 'card-request',
      context: { orderType: 'pickup', editMode: false }, submission: { clientRequestId: 'card-request', paymentData: { method: 'card', amount: 4 }, items: [] } };
    const complete = vi.fn(async () => true); render(<MenuModal {...baseProps} isOpen onOrderComplete={complete} />);
    fireEvent.click(await screen.findByText('Check original checkout')); await act(async () => {});
    expect(complete).not.toHaveBeenCalled(); expect(draftStorage.draft.checkoutRequestId).toBe('card-request');
  });
  it('explicit stored decline renews the real parent identity only after native CAS, without starting payment', async () => {
    draftStorage.draft = { ...editor(), draftId: 'declined-card', checkoutRequestId: 'card-request',
      context: { orderType: 'pickup', editMode: false }, submission: { clientRequestId: 'card-request', paymentData: { method: 'card', amount: 4 } } };
    draftStorage.inspection = { success: true, outcome: 'declined', canCollect: false };
    const complete = vi.fn(async () => true); const restore = vi.fn();
    function Parent() {
      const identity = useCheckoutRequestId();
      return <MenuModal {...baseProps} isOpen onOrderComplete={async data => {
        identity.take(data.clientRequestId);
        return complete(data);
      }} onDraftRestore={(context, renewal) => {
        identity.restore(context.checkoutRequestId, { phase: context.checkoutPhase, renewedFrom: renewal?.previousCheckoutRequestId });
        restore(context, renewal);
      }} />;
    }
    render(<Parent />);
    fireEvent.click(await screen.findByText('Check original checkout'));
    await waitFor(() => expect(draftStorage.draft.checkoutRequestId).toBe('renewed-request'));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(expect.objectContaining({ checkoutRequestId: 'renewed-request', checkoutPhase: 'editing' }), { previousCheckoutRequestId: 'card-request' }));
    expect(complete).not.toHaveBeenCalled(); expect(draftStorage.draft.cartItems).toEqual(editor().cartItems);
    expect(draftStorage.draft.phase).toBe('editing'); expect(draftStorage.draft.submission).toBeUndefined();
    await waitFor(() => expect(screen.getByText('Checkout')).not.toBeDisabled());
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Pay cash'));
    await waitFor(() => expect(complete).toHaveBeenCalledWith(expect.objectContaining({ clientRequestId: 'renewed-request' })));
  });
  it('native mixed evidence appearing after inspection cannot release or replace the frozen cart', async () => {
    draftStorage.draft = { ...editor(), checkoutRequestId: 'card-request', context: { orderType: 'pickup', editMode: false },
      submission: { clientRequestId: 'card-request', paymentData: { method: 'card' } } };
    draftStorage.inspection = { success: true, outcome: 'declined', canCollect: false };
    draftStorage.resumeError = 'CHECKOUT_DRAFT_DECLINE_NOT_PROVEN';
    const complete = vi.fn(async () => true); const restore = vi.fn();
    render(<MenuModal {...baseProps} isOpen onOrderComplete={complete} onDraftRestore={restore} />);
    fireEvent.click(await screen.findByText('Check original checkout')); await act(async () => {});
    expect(draftStorage.draft.checkoutRequestId).toBe('card-request'); expect(draftStorage.draft.phase).toBe('checkout_pending');
    fireEvent.click(screen.getByText('Checkout')); expect(screen.queryByText('Pay cash')).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(restore.mock.calls.some(call => call[1] !== undefined)).toBe(false);
  });
  it.each(['not_sent', 'not_charged'])('explicit native %s proof renews the cart without payment dispatch', async outcome => {
    draftStorage.draft = { ...editor(), checkoutRequestId: 'card-request', context: { orderType: 'pickup', editMode: false },
      submission: { clientRequestId: 'card-request', paymentData: { method: 'card' } } };
    draftStorage.inspection = { success: true, outcome, canCollect: false };
    const complete = vi.fn(async () => true); const restore = vi.fn();
    render(<MenuModal {...baseProps} isOpen onOrderComplete={complete} onDraftRestore={restore} />);
    fireEvent.click(await screen.findByText('Check original checkout'));
    await waitFor(() => expect(draftStorage.draft.checkoutRequestId).toBe('renewed-request'));
    await waitFor(() => expect(screen.getByText('Checkout')).not.toBeDisabled());
    expect(complete).not.toHaveBeenCalled(); expect(draftStorage.draft.cartItems).toEqual(editor().cartItems);
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ checkoutRequestId: 'renewed-request', checkoutPhase: 'editing' }), { previousCheckoutRequestId: 'card-request' });
  });
});
