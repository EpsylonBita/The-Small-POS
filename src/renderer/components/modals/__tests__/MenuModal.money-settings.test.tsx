import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  admissionError: null as string | null,
  legacyAdmission: false,
  confirmationError: false,
  draftFreezeError: false,
  editOrder: null as any,
  inspect: null as any,
  applyEditSettlement: vi.fn(),
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
    staff: { branchId: 'branch-1', organizationId: 'org-1', terminalId: 'terminal-1' },
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
  getCachedTerminalCredentials: vi.fn(() => ({ branchId: 'branch-1', organizationId: 'org-1', terminalId: 'terminal-1' })),
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

const draftStorage = vi.hoisted(() => ({ draft: null as any, generation: 0, invalidated: false }));
beforeEach(() => { draftStorage.draft = null; draftStorage.generation = 0; draftStorage.invalidated = false; });
vi.mock('../../../../lib', async (importOriginal) => {
  const bridge = {
    invoke: vi.fn(async (command: string, input: any) => {
      if (command === 'checkout_draft_check_admission') {
        if (mocks.admissionError) throw new Error(mocks.admissionError);
        if (mocks.legacyAdmission) return { success: false, code: 'LEGACY_SHIFT_CURRENCY_CONFIRMATION_REQUIRED', shiftId: 'legacy-shift', currency: 'EUR' };
        return { success: true, currency: 'EUR' };
      }
      if (command === 'shift_confirm_legacy_currency') {
        if (mocks.confirmationError) throw new Error('APPROVAL_REQUIRED');
        mocks.legacyAdmission = false;
        return { success: true };
      }
      if (command === 'checkout_draft_inspect') return mocks.inspect ?? { success: true, outcome: 'not_found', canCollect: false };
      if (command === 'checkout_draft_put') {
        if (mocks.draftFreezeError && input.draft.phase === 'checkout_pending') throw new Error('DISK_UNAVAILABLE');
        draftStorage.draft = input.draft; draftStorage.generation++;
      }
      if (command === 'checkout_draft_delete') { draftStorage.draft = null; draftStorage.generation++; }
      return { success: true, scope: { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'terminal-1' }, generation: draftStorage.generation, draft: draftStorage.draft,
        ...(draftStorage.invalidated ? { invalidation: { reason: 'edit_target_cancelled', orderId: 'cancelled-order' } } : {}) };
    }),
    settings: { get: vi.fn(async () => null) },
    orders: { getById: vi.fn(async () => mocks.editOrder), applyEditSettlement: (...args: any[]) => mocks.applyEditSettlement(...args) },
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
import { menuService } from '../../../services/MenuService';

const customer = { id: 'customer-1', name: 'Test Customer', phone: '6900000000' };

const renderMenu = (onClose = vi.fn()) =>
  render(
    <MenuModal
      isOpen
      onClose={onClose}
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
  mocks.admissionError = null;
  mocks.legacyAdmission = false;
  mocks.confirmationError = false;
  mocks.editOrder = null;
  mocks.draftFreezeError = false;
  mocks.inspect = null;
  mocks.applyEditSettlement.mockReset();
});

afterEach(() => {
  cleanup();
});

it('closes a cancelled order editor archived by native recovery without showing save failure or saving a replacement', async () => {
  draftStorage.invalidated = true;
  const onClose = vi.fn();
  renderMenu(onClose);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(mocks.toastError).toHaveBeenCalledWith('modals.menu.draftTargetCancelled');
  expect(screen.queryByText('modals.menu.draftSaveFailed')).toBeNull();
  expect(draftStorage.generation).toBe(0);
  expect(draftStorage.draft).toBeNull();
});

describe('MenuModal paid edit lifecycle', () => {
  it('waits for controlled restore props without reporting a failed save or changing the retained cart', async () => {
    mocks.settings.unavailable = false;
    const retainedItems = [
      { id: 'original-line', menuItemId: 'espresso', name: 'Espresso', quantity: 1, unitPrice: 6, totalPrice: 6 },
      { id: 'added-line', menuItemId: 'extra', name: 'Extra', quantity: 1, unitPrice: 4.5, totalPrice: 4.5 },
    ];
    draftStorage.generation = 14;
    draftStorage.draft = { schemaVersion: 1, draftId: 'retained-cart', checkoutRequestId: 'rotated-edit-attempt',
      phase: 'editing', cartItems: retainedItems, state: {},
      context: { editMode: true, editOrderId: 'paid-order', editExpectedVersion: 1, orderType: 'pickup' } };
    const restore = vi.fn();
    const props = { isOpen: true, onClose: vi.fn(), orderType: 'pickup' as const, onDraftRestore: restore };
    const view = render(<MenuModal {...props} editMode={false} />);
    await waitFor(() => expect(restore).toHaveBeenCalledOnce());
    expect(screen.queryByText('modals.menu.draftSaveFailed')).toBeNull();
    expect(draftStorage.generation).toBe(14);
    expect(draftStorage.draft.cartItems).toEqual(retainedItems);
    view.rerender(<MenuModal {...props} editMode editOrderId="paid-order" />);
    await waitFor(() => expect(draftStorage.generation).toBeGreaterThan(14));
    expect(screen.queryByText('modals.menu.draftSaveFailed')).toBeNull();
    expect(draftStorage.draft.checkoutRequestId).toBe('rotated-edit-attempt');
    expect(draftStorage.draft.cartItems).toEqual(retainedItems);
  });

  const openEdit = async (onEditComplete: any, onClose = vi.fn(), requiredAction: 'collect' | 'refund' | 'none' = 'collect',
    options: { start?: boolean; preflight?: any } = {}) => {
    mocks.settings.unavailable = false;
    mocks.editOrder = { id: 'paid-order', version: 1, order_type: 'pickup', items: [
      { id: 'original-line', menu_item_id: 'espresso', name: 'Espresso', quantity: 1, unit_price: 6, total_price: 6 },
    ] };
    render(<MenuModal isOpen onClose={onClose} orderType="pickup" editMode editOrderId="paid-order"
      onEditPreflight={options.preflight || (async () => ({ kind: 'settlement', requiredAction, canonicalExpectedVersion: 3, localExpectedVersion: 1 }))} onEditComplete={onEditComplete} />);
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    if (options.start !== false) fireEvent.click(screen.getByText('Checkout'));
    return onClose;
  };

  const submissionFor = (data: any) => ({ ...data, action: 'edit_settlement',
    settlementAction: { type: 'collect', method: 'card' },
    settlementRequest: { orderId: data.orderId, client_event_id: data.client_event_id,
      expected_version: data.expected_version, expected_local_version: data.expected_local_version, items: data.items, action: { type: 'collect', method: 'card' } },
  });

  it('restores staged delivery headers and retains them after cancelling before any money confirmation', async () => {
    mocks.settings.unavailable=false;
    mocks.editOrder={ id:'paid-order', version:7, order_type:'pickup', total_amount:10.5, items:[{ id:'old', name:'Original', quantity:1, unit_price:10.5, total_price:10.5 }] };
    const headers={ orderUpdates:{ orderType:'delivery' as const, customerName:'Selected', deliveryAddress:'New street', deliveryAddressId:null }, deliveryFee:0 };
    draftStorage.draft={ schemaVersion:1, draftId:'restored-header',checkoutRequestId:'same-attempt',phase:'editing',cartItems:[{ id:'new',name:'Original',quantity:1,unitPrice:11.5,totalPrice:11.5,price:11.5 }],state:{},context:{ editMode:true,editOrderId:'paid-order',editExpectedVersion:7,orderType:'delivery',editHeaders:headers } };
    const preflight=vi.fn(async()=>({ kind:'settlement' as const,requiredAction:'collect' as const,canonicalExpectedVersion:7,localExpectedVersion:1 }));
    const commit=vi.fn(async()=>{throw new Error('EDIT_SETTLEMENT_CANCELLED');});
    render(<MenuModal isOpen onClose={vi.fn()} orderType="delivery" editMode editOrderId="paid-order" editHeaders={headers} onEditPreflight={preflight} onEditComplete={commit} />);
    await waitFor(()=>expect(draftStorage.draft.context).toHaveProperty('editOriginalOrder'));
    fireEvent.click(screen.getByText('Checkout'));
    await waitFor(()=>expect(commit).toHaveBeenCalledOnce());
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ total:11.5,orderUpdates:expect.objectContaining(headers.orderUpdates),financials:{totalAmount:11.5,deliveryFee:0} }));
    expect(draftStorage.draft.phase).toBe('editing');expect(draftStorage.draft.submission).toBeUndefined();
    expect(draftStorage.draft.context.editHeaders).toEqual(headers);
  });

  it('keeps a stale canonical order editable and asks for refresh before any confirmation', async () => {
    const commit = vi.fn();
    await openEdit(commit, vi.fn(), 'collect', { preflight: async () => { throw new Error('EDIT_CANONICAL_ORIGINAL_CHANGED'); } });
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('modals.menu.editCanonicalChanged'));
    expect(commit).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
    expect(draftStorage.draft?.submission).toBeUndefined();
  });

  it('fences same-tick repeated Save and Close while preflight is unresolved, then unlocks on refusal', async () => {
    let refuse!: (error: Error) => void;
    const preflight = vi.fn(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const commit = vi.fn();
    const close = await openEdit(commit, vi.fn(), 'collect', { start: false, preflight });
    act(() => {
      fireEvent.click(screen.getByText('Checkout'));
      fireEvent.click(screen.getByText('Checkout'));
      fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    });
    await waitFor(() => expect(preflight).toHaveBeenCalledOnce());
    expect(commit).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await act(async () => refuse(new Error('POS_ORDER_SETTLEMENT_UNAVAILABLE')));
    expect(draftStorage.draft?.phase).toBe('editing');
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('retains the editor while its picker waits and permits closing the pending original after a failed save', async () => {
    let confirm!: () => Promise<void>;
    const commit = vi.fn((data, lifecycle) => new Promise<void>((_resolve, reject) => {
      confirm = async () => { await lifecycle.beforeCommit(submissionFor(data)); reject(new Error('IPC_RESPONSE_LOST')); };
    }));
    const close = await openEdit(commit);
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    fireEvent.click(screen.getByText('Checkout'));
    expect(close).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    await act(async () => confirm());
    expect(draftStorage.draft?.phase).toBe('checkout_pending');
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    expect(close).toHaveBeenCalledOnce();
    expect(draftStorage.draft?.submission.action).toBe('edit_settlement');
  });

  it('does not dismiss a confirmed original that only remains in memory after its durable freeze failed', async () => {
    mocks.draftFreezeError = true;
    const dispatch = vi.fn();
    const commit = vi.fn(async (data, lifecycle) => {
      await lifecycle.beforeCommit(submissionFor(data));
      dispatch();
    });
    const close = await openEdit(commit);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('modals.menu.editFailed'));
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    expect(close).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
  });

  it('checks legacy currency before showing a paid-edit picker or freezing the cart', async () => {
    mocks.legacyAdmission = true;
    const commit = vi.fn();
    await openEdit(commit);
    await screen.findByRole('dialog', { name: 'modals.menu.legacyCurrency.title' });
    expect(commit).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
    expect(draftStorage.draft?.submission).toBeUndefined();
  });

  it('cancelling the delta picker keeps an editable cart without a retained payment attempt', async () => {
    const commit = vi.fn(async () => { throw new Error('EDIT_SETTLEMENT_CANCELLED'); });
    const close = await openEdit(commit);
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('does not clear the order when a parent resolves before any confirmed commit', async () => {
    const close = await openEdit(vi.fn(async () => undefined));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('modals.menu.editFailed'));
    expect(close).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
  });

  it.each(['collect', 'refund', 'none'] as const)('retains the exact %s edit before dispatch and clears only after acceptance', async (requiredAction) => {
    let frozen: any;
    const commit = vi.fn(async (data, lifecycle) => {
      const original = submissionFor(data);
      original.settlementAction.type = requiredAction;
      original.settlementRequest.action.type = requiredAction;
      await lifecycle.beforeCommit(original);
      frozen = structuredClone(draftStorage.draft);
    });
    const close = await openEdit(commit, vi.fn(), requiredAction);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(frozen.phase).toBe('checkout_pending');
    expect(frozen.submission.settlementRequest.action.type).toBe(requiredAction);
    expect(frozen.submission.expected_version).toBe(3);
    expect(frozen.submission.expected_local_version).toBe(1);
    expect(frozen.submission.settlementRequest.expected_version).toBe(3);
    expect(frozen.submission.settlementRequest.expected_local_version).toBe(1);
    expect(draftStorage.draft).toBeNull();
  });

  it('an unknown confirmed outcome retains the original method and event without opening another picker', async () => {
    let confirmed: any;
    const commit = vi.fn(async (data, lifecycle) => {
      confirmed = submissionFor(data);
      await lifecycle.beforeCommit(confirmed);
      throw new Error('IPC_RESPONSE_LOST');
    });
    const close = await openEdit(commit);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('modals.menu.editFailed'));
    expect(close).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('checkout_pending');
    expect(draftStorage.draft?.submission.settlementRequest).toEqual(confirmed.settlementRequest);
    fireEvent.click(screen.getByText('Checkout'));
    expect(commit).toHaveBeenCalledOnce();
  });
});

describe('MenuModal when the store discount cap cannot be read', () => {
  it('an upgrade confirmation preserves the editable cart and never starts payment automatically', async () => {
    mocks.settings.unavailable = false;
    mocks.legacyAdmission = true;
    renderMenu();
    fireEvent.click(await screen.findByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));
    await screen.findByRole('dialog', { name: 'modals.menu.legacyCurrency.title' });
    expect(draftStorage.draft?.phase).toBe('editing');
    expect(screen.queryByTestId('payment-modal')).toBeNull();
    fireEvent.click(screen.getByText('modals.menu.legacyCurrency.confirm'));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'modals.menu.legacyCurrency.title' })).toHaveClass('leaving'));
    const closingDialog = screen.getByRole('dialog', { name: 'modals.menu.legacyCurrency.title' });
    // React uses the WebKit event fallback in jsdom without AnimationEvent.
    for (const type of ['animationend', 'webkitAnimationEnd', 'mozAnimationEnd']) {
      fireEvent(closingDialog, new Event(type, { bubbles: true }));
    }
    await waitFor(() => expect(screen.queryByText('modals.menu.legacyCurrency.title')).toBeNull());
    expect(screen.queryByTestId('payment-modal')).toBeNull();
    expect(draftStorage.draft?.cartItems).toHaveLength(1);
    fireEvent.click(screen.getByText('Checkout'));
    await screen.findByTestId('payment-modal');
  });

  it('a refused upgrade confirmation keeps the cart editable and the payment closed', async () => {
    mocks.settings.unavailable = false;
    mocks.legacyAdmission = true;
    mocks.confirmationError = true;
    renderMenu();
    fireEvent.click(await screen.findByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('modals.menu.legacyCurrency.confirm'));
    await screen.findByText('modals.menu.legacyCurrency.failed');
    expect(draftStorage.draft?.phase).toBe('editing');
    expect(screen.queryByTestId('payment-modal')).toBeNull();
  });

  it('closes an unpaid editing cart immediately without a discard confirmation', async () => {
    const onClose = vi.fn();
    renderMenu(onClose);
    fireEvent.click(await screen.findByText('Add espresso'));
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Discard this order?')).toBeNull();
    expect(draftStorage.draft).toBeNull();
  });

  it('checks native shift currency before showing payment or freezing the cart', async () => {
    mocks.settings.unavailable = false;
    mocks.admissionError = 'SHIFT_CURRENCY_UNAVAILABLE';
    const onClose = vi.fn();
    renderMenu(onClose);
    fireEvent.click(await screen.findByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(screen.queryByTestId('payment-modal')).toBeNull();
    expect(draftStorage.draft?.phase).toBe('editing');
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(draftStorage.draft).toBeNull();
  });
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

describe('MenuModal paid edit corrections (06/10/2026)', () => {
  const editOrder = (items: any[], extra: Record<string, unknown> = {}) => {
    mocks.settings.unavailable = false;
    mocks.editOrder = { id: 'paid-order', version: 1, order_type: 'pickup', items, ...extra };
  };

  it('keeps each retained line\u2019s recorded VAT class in the correction', async () => {
    editOrder([{ id: 'original-line', menu_item_id: 'espresso', name: 'Espresso', quantity: 1, unit_price: 6, total_price: 6,
      vat_category_code: 'gr_reduced_13', price_includes_vat: false, vat_rate_percent: 13, fiscal_document_profile: 'retail' }]);
    const preflight = vi.fn(async () => ({ kind: 'ordinary' as const }));
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" editMode editOrderId="paid-order"
      onEditPreflight={preflight} onEditComplete={vi.fn(async () => undefined)} />);
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    fireEvent.click(screen.getByText('Checkout'));
    await waitFor(() => expect(preflight).toHaveBeenCalledOnce());
    expect(preflight.mock.calls[0][0].items[0]).toMatchObject({ vat_category_code: 'gr_reduced_13', price_includes_vat: false,
      vat_rate_percent: 13, fiscal_document_profile: 'retail' });
  });

  it('a fulfillment conversion makes the new tier price the original, never a manual override', async () => {
    vi.mocked(menuService.getMenuItemById).mockImplementation(async () => ({ id: 'espresso', name: 'Espresso', price: 6, pickup_price: 6, delivery_price: 7 }) as any);
    editOrder([{ id: 'original-line', menu_item_id: 'espresso', name: 'Espresso', quantity: 1, unit_price: 6, total_price: 6 }]);
    const preflight = vi.fn(async () => ({ kind: 'ordinary' as const }));
    render(<MenuModal isOpen onClose={vi.fn()} orderType="delivery" editMode editOrderId="paid-order" editSourceOrderType="pickup"
      onEditPreflight={preflight} onEditComplete={vi.fn(async () => undefined)} />);
    await waitFor(() => expect(draftStorage.draft?.cartItems?.[0]?.unitPrice).toBe(7));
    fireEvent.click(screen.getByText('Checkout'));
    await waitFor(() => expect(preflight).toHaveBeenCalledOnce());
    expect(preflight.mock.calls[0][0].items[0]).toMatchObject({ unit_price: 7, original_unit_price: 7, is_price_overridden: false });
    vi.mocked(menuService.getMenuItemById).mockReset();
    vi.mocked(menuService.getMenuItemById).mockImplementation(async () => null);
  });

  const refusedDraft = () => {
    draftStorage.generation = 4;
    draftStorage.draft = { schemaVersion: 1, draftId: 'frozen-edit', checkoutRequestId: 'refused-event', phase: 'checkout_pending',
      cartItems: [{ id: 'original-line', menuItemId: 'espresso', name: 'Espresso', quantity: 1, unitPrice: 6, totalPrice: 6 }],
      state: {}, context: { editMode: true, editOrderId: 'paid-order', editExpectedVersion: 1, orderType: 'pickup' },
      submission: { action: 'edit_settlement', orderId: 'paid-order', client_event_id: 'refused-event', expected_version: 1,
        expected_local_version: 1, items: [], settlementAction: { type: 'collect', payments: [] }, settlementRequest: {} } };
    mocks.inspect = { success: true, outcome: 'uncertain', canCollect: false,
      recovery: { state: 'refused', response: { success: false, code: 'EDIT_SETTLEMENT_NOT_APPLIED', requoteAllowed: true } } };
  };

  it('a confirmed correction proven never applied is prepared again under a new event that replaces it', async () => {
    editOrder([{ id: 'original-line', menu_item_id: 'espresso', name: 'Espresso', quantity: 1, unit_price: 6, total_price: 6 }]);
    refusedDraft();
    const complete = vi.fn(async (data: any) => { if (data.action === 'edit_settlement') throw new Error('EDIT_CANONICAL_ORIGINAL_CHANGED'); });
    const preflight = vi.fn(async () => ({ kind: 'ordinary' as const }));
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" editMode editOrderId="paid-order"
      onEditPreflight={preflight} onEditComplete={complete} />);
    fireEvent.click(await screen.findByText('Check original checkout'));
    await screen.findByTestId('menu-edit-not-applied');
    expect(draftStorage.draft.phase).toBe('checkout_pending');
    fireEvent.click(screen.getByTestId('menu-edit-requote'));
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    expect(draftStorage.draft.checkoutRequestId).not.toBe('refused-event');
    expect(draftStorage.draft.context.supersedesEditEvent).toBe('refused-event');
    expect(draftStorage.draft.cartItems).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId('menu-edit-not-applied')).toBeNull());
    fireEvent.click(screen.getByText('Checkout'));
    await waitFor(() => expect(preflight).toHaveBeenCalledOnce());
    expect(preflight.mock.calls[0][0]).toMatchObject({ supersedes_client_event_id: 'refused-event' });
    expect(preflight.mock.calls[0][0].client_event_id).not.toBe('refused-event');
    expect(mocks.applyEditSettlement).not.toHaveBeenCalled();
  });

  it('a manager closes a correction proven never applied without recording money', async () => {
    editOrder([{ id: 'original-line', menu_item_id: 'espresso', name: 'Espresso', quantity: 1, unit_price: 6, total_price: 6 }]);
    refusedDraft();
    mocks.applyEditSettlement.mockResolvedValue({ success: true, state: 'reconciled' });
    const complete = vi.fn(async () => { throw new Error('EDIT_SETTLEMENT_METHOD_UNAVAILABLE'); });
    const close = vi.fn();
    render(<MenuModal isOpen onClose={close} orderType="pickup" editMode editOrderId="paid-order"
      onEditPreflight={vi.fn(async () => ({ kind: 'ordinary' as const }))} onEditComplete={complete} />);
    fireEvent.click(await screen.findByText('Check original checkout'));
    fireEvent.click(await screen.findByTestId('menu-edit-close-without-money'));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(mocks.applyEditSettlement).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'paid-order', client_event_id: 'refused-event',
      reconcile: expect.objectContaining({ decision: 'close_without_money' }) }));
    expect(draftStorage.draft).toBeNull();
  });

  it('a refused correction that is not proven never applied keeps the original held', async () => {
    editOrder([{ id: 'original-line', menu_item_id: 'espresso', name: 'Espresso', quantity: 1, unit_price: 6, total_price: 6 }]);
    refusedDraft();
    mocks.inspect = { success: true, outcome: 'uncertain', canCollect: false, recovery: { state: 'prepared', response: null } };
    const complete = vi.fn(async () => { throw new Error('IPC_RESPONSE_LOST'); });
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" editMode editOrderId="paid-order"
      onEditPreflight={vi.fn(async () => ({ kind: 'ordinary' as const }))} onEditComplete={complete} />);
    fireEvent.click(await screen.findByText('Check original checkout'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('The original checkout could not be verified. Its saved cart remains protected.'));
    expect(screen.queryByTestId('menu-edit-not-applied')).toBeNull();
    expect(draftStorage.draft.phase).toBe('checkout_pending');
    expect(draftStorage.draft.checkoutRequestId).toBe('refused-event');
  });

  it.each([
    ['LEGACY_EDIT_REVIEW_REQUIRED', 'modals.menu.legacyEditReview'],
    ['EDIT_TOO_MANY_LINES', 'modals.menu.editTooManyLines'],
    ['EDIT_SETTLEMENT_METHOD_UNAVAILABLE', 'modals.menu.editMethodUnavailable'],
  ])('explains %s before any money is confirmed', async (code, key) => {
    const commit = vi.fn();
    editOrder([{ id: 'original-line', menu_item_id: 'espresso', name: 'Espresso', quantity: 1, unit_price: 6, total_price: 6 }]);
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" editMode editOrderId="paid-order"
      onEditPreflight={async () => { throw new Error(code); }} onEditComplete={commit} />);
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    fireEvent.click(screen.getByText('Checkout'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(key));
    expect(commit).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
  });
});
