import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Item H, fix review 30/09/2026 (the same decision as Android). While the
// store's discount cap cannot be read, the order menu used to cap discounts
// on an assumed 30% and go on to payment. Now checkout pauses with a clear
// message and "Try again", and no discount is allowed on an assumed cap.

const mocks = vi.hoisted(() => ({
  coupon: null as any,
  loyaltyEnabled: false,
  redeem: vi.fn(),
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
  confirmationFreezeError: false,
  readError: false,
  freezeAckLost: false,
  readbackChange: null as null | ((draft: any) => any),
  editOrder: null as any,
  inspect: null as any,
  applyEditSettlement: vi.fn(),
  refreshFromServer: vi.fn(async (): Promise<any> => ({ success: true, orderId: 'paid-order', refreshed: ['items.identity'] })),
  reportEditRefusal: vi.fn(async () => ({ success: true })),
  recoverySnapshot: vi.fn(),
  appointmentClaims: vi.fn(async (): Promise<any> => null),
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
  const value = { hasModule: (id: string) => mocks.loyaltyEnabled && id === actual.MODULE_IDS.LOYALTY };
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

vi.mock('../../../services/appointment-checkout-claims', () => ({
  confirmAppointmentClaimsBeforePayment: mocks.appointmentClaims,
}));

vi.mock('../../../utils/api-helpers', () => ({
  posApiGet: vi.fn(async () => ({ success: false })),
  posApiPost: vi.fn(async () => ({ success: true, data: { valid: true, coupon: mocks.coupon } })),
}));

vi.mock('../../../utils/catalog-offers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/catalog-offers')>()),
  validateCatalogOffers: vi.fn(async () => null),
}));

const draftStorage = vi.hoisted(() => ({ draft: null as any, generation: 0, invalidated: false, deletes: 0, deleteError: false,
  loadGate: null as Promise<void> | null, parked: null as any, parkError: null as string | null }));
beforeEach(() => {
  draftStorage.draft = null; draftStorage.generation = 0; draftStorage.invalidated = false;
  draftStorage.deletes = 0; draftStorage.deleteError = false; draftStorage.loadGate = null;
  draftStorage.parked = null; draftStorage.parkError = null;
});
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
      if (command === 'checkout_draft_get' && draftStorage.loadGate) await draftStorage.loadGate;
      if (command === 'checkout_draft_get' && mocks.readError) throw new Error('DISK_UNAVAILABLE');
      if (command === 'checkout_draft_report_failure') return { success: true };
      if (command === 'checkout_draft_inspect') return mocks.inspect ?? { success: true, outcome: 'not_found', canCollect: false };
      if (command === 'checkout_draft_put') {
        if ((mocks.draftFreezeError && input.draft.phase === 'checkout_pending') ||
          (mocks.confirmationFreezeError && input.draft.state.paymentAdmission === 'confirmed')) throw new Error('DISK_UNAVAILABLE');
        draftStorage.draft = mocks.readbackChange ? mocks.readbackChange(input.draft) : input.draft; draftStorage.generation++;
        if (mocks.freezeAckLost && input.draft.phase === 'checkout_pending') { mocks.freezeAckLost = false; throw new Error('IPC_LOST'); }
      }
      if (command === 'checkout_draft_delete') {
        if (draftStorage.deleteError) throw new Error('DISK_UNAVAILABLE');
        draftStorage.deletes++; draftStorage.draft = null; draftStorage.generation++;
      }
      if (command === 'checkout_draft_park') {
        if (draftStorage.parkError) throw new Error(draftStorage.parkError);
        if (input.expectedGeneration !== draftStorage.generation || input.clientRequestId !== draftStorage.draft?.checkoutRequestId) throw new Error('CHECKOUT_DRAFT_VERSION_CHANGED');
        draftStorage.parked = draftStorage.draft; draftStorage.draft = null; draftStorage.generation++;
        return { success: true, scope: { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'terminal-1' }, generation: draftStorage.generation, draft: null,
          parked: { outcome: 'uncertain', generation: draftStorage.generation - 1 } };
      }
      return { success: true, scope: { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'terminal-1' }, generation: draftStorage.generation, draft: draftStorage.draft,
        ...(draftStorage.invalidated ? { invalidation: { reason: 'edit_target_cancelled', orderId: 'cancelled-order' } } : {}) };
    }),
    settings: { get: vi.fn(async () => null) },
    recovery: { createPreActionSnapshot: mocks.recoverySnapshot },
    orders: { getById: vi.fn(async () => mocks.editOrder), applyEditSettlement: (...args: any[]) => mocks.applyEditSettlement(...args),
      refreshFromServer: (...args: any[]) => mocks.refreshFromServer(...args), reportEditRefusal: (...args: any[]) => mocks.reportEditRefusal(...args) },
    branchData: { validateCoupon: vi.fn(async () => ({ success: true, data: { valid: true, coupon: mocks.coupon } })) },
    loyalty: {
      redeemPoints: (...args: any[]) => mocks.redeem(...args),
      releaseRedemption: vi.fn(async () => ({ success: true })),
      getSettings: vi.fn(async () => ({ settings: { is_active: true, min_redemption_points: 100, redemption_rate: 0.01 } })),
      getCustomerBalance: vi.fn(async () => ({ customer: { points_balance: 1000 } })),
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
  MenuCart: ({ onCheckout, maxDiscountPercentage, onApplyCoupon, appliedCoupon, couponDiscount, onRemoveItem, cartItems, onOpenLoyaltyRedeem, loyaltyRedemption }: any) => {
    mocks.cartMaxDiscount.push(maxDiscountPercentage);
    return (
      <div data-testid="menu-cart">
        <button onClick={onCheckout}>Checkout</button>
        <button onClick={() => onApplyCoupon('SAVE')}>Apply coupon</button>
        <button onClick={() => onRemoveItem(cartItems[0].id)}>Remove first item</button>
        <button onClick={onOpenLoyaltyRedeem}>Redeem points</button>
        <span data-testid="applied-coupon">{appliedCoupon?.code ?? 'none'}</span>
        <span data-testid="coupon-discount">{couponDiscount}</span>
        <span data-testid="loyalty-applied">{loyaltyRedemption?.pointsRedeemed ?? 0}</span>
      </div>
    );
  },
}));
vi.mock('../../menu/MenuItemModal', () => ({ MenuItemModal: () => null }));
vi.mock('../../menu/ComboChoiceModal', () => ({ ComboChoiceModal: () => null }));
vi.mock('../PaymentModal', () => ({
  PaymentModal: ({ isOpen, onPaymentComplete, onBeforePayment, onSplitPayment, orderTotal }: any) => (isOpen ? <div data-testid="payment-modal">payment
    <button onClick={() => onBeforePayment({ method: 'twint', amount: 7, currency: 'CHF', idempotencyKey: 'loyalty-twint' })}>Admit loyalty QR</button>
    <button onClick={() => onPaymentComplete({ method: 'twint', amount: 7, currency: 'CHF', idempotencyKey: 'loyalty-twint', metadata: { provider: 'twint', confirmation: 'cashier', confirmation_action: 'confirm' } })}>Confirm loyalty receipt</button>
    <button onClick={() => onBeforePayment({ method: 'twint', amount: 7.2, currency: 'CHF', idempotencyKey: 'admitted-twint' })}>Admit QR</button>
    <button onClick={() => onPaymentComplete({ method: 'twint', amount: 7.2, currency: 'CHF', idempotencyKey: 'admitted-twint', metadata: { provider: 'twint', confirmation: 'cashier', confirmation_action: 'confirm' } })}>Confirm TWINT receipt</button>
    <button onClick={() => onBeforePayment({ method: 'card', amount: 7.2, transactionId: 'approved-card' })}>Admit card</button>
    <button onClick={() => onPaymentComplete({ method: 'card', amount: 7.2, transactionId: 'approved-card' })}>Complete approved card</button>
    <button onClick={async () => { const data = { method: 'cash', amount: orderTotal }; if (await onBeforePayment(data)) await onPaymentComplete(data); }}>Confirm cash</button>
    <button onClick={async () => { if (await onBeforePayment({ method: 'cash', amount: orderTotal })) await onPaymentComplete({ method: 'cash', amount: orderTotal + 1 }); }}>Confirm cash for another amount</button>
    <button onClick={async () => { const data = { method: 'card', amount: orderTotal }; if (await onBeforePayment(data)) await onPaymentComplete(data); }}>Confirm card</button>
    <button onClick={() => onSplitPayment(null)}>Confirm split</button>
  </div> : null),
}));
vi.mock('../LoyaltyRedeemModal', () => ({ LoyaltyRedeemModal: ({ isOpen, onRedeem }: any) => isOpen ? <button onClick={() => onRedeem(1, 100)}>Use 100 points</button> : null }));

import { MenuModal } from '../MenuModal';
import { RendererEditRefusal } from '../../../services/MenuOrderEdit';
import { menuService } from '../../../services/MenuService';
import { getBridge } from '../../../../lib';

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
  mocks.coupon = { id: 'coupon-1', code: 'SAVE', discount_type: 'percentage', discount_value: 10, min_order_amount: 10 };
  mocks.loyaltyEnabled = false;
  mocks.redeem.mockReset().mockResolvedValue({ success: true });
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
  mocks.confirmationFreezeError = false;
  mocks.readError = false;
  mocks.freezeAckLost = false;
  mocks.readbackChange = null;
  mocks.inspect = null;
  mocks.applyEditSettlement.mockReset();
  mocks.recoverySnapshot.mockReset().mockResolvedValue({ id: 'pre-action-snapshot' });
  mocks.appointmentClaims.mockReset().mockResolvedValue(null);
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

describe('MenuModal recovery after a failed durable freeze', () => {
  // Tomikro 21/10/2026: a freeze whose write failed comes before any
  // collection. With native proof that it never committed, the cart is
  // editable again and Pay retries it. While storage stays unreadable the
  // original is kept, nothing is collected and nothing is dispatched.
  const freezeNotSaved = 'The cart could not be saved for payment, so no payment was started. Press Pay to try again.';

  async function openFrozenCreate(method: 'cash' | 'card', onOrderComplete: any, unreadable = false, onClose = vi.fn()) {
    mocks.settings.unavailable = false;
    render(<MenuModal isOpen onClose={onClose} orderType="pickup" onOrderComplete={onOrderComplete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    const originalId = draftStorage.draft.checkoutRequestId;
    mocks.draftFreezeError = true;
    mocks.readError = unreadable;
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText(`Confirm ${method}`));
    return { originalId, onClose };
  }

  it.each(['cash', 'card'] as const)('a %s freeze that never committed returns the editable cart, and Pay then saves it once', async method => {
    const accepted = vi.fn(async () => true);
    const { originalId } = await openFrozenCreate(method, accepted);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(freezeNotSaved));
    expect(screen.queryByText('modals.menu.draftSaveFailed')).toBeNull();
    expect(screen.queryByText('Check original checkout')).toBeNull();
    // The editable cart is durable at once, not only when it next changes.
    expect(draftStorage.draft).toMatchObject({ checkoutRequestId: originalId, phase: 'editing', state: { paymentAdmissionCancelled: true } });
    expect(draftStorage.draft.cartItems).toHaveLength(1);
    expect(accepted).not.toHaveBeenCalled();
    mocks.draftFreezeError = false;
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText(`Confirm ${method}`));
    await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(accepted.mock.calls[0][0]).toMatchObject({ clientRequestId: originalId, paymentData: { method } });
  });

  it('while storage stays unreadable the original is kept and nothing is collected; once it reads, the cart returns', async () => {
    const accepted = vi.fn(async () => true);
    const { originalId, onClose } = await openFrozenCreate('cash', accepted, true);
    await screen.findByText('modals.menu.draftSaveFailed');
    expect((screen.getByText('Return to orders') as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(getBridge().invoke).mockClear();
    fireEvent.click(screen.getByText('Check original checkout'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('The original checkout could not be verified. Its saved cart remains protected.'));
    const commands = vi.mocked(getBridge().invoke).mock.calls.map(call => call[0]);
    expect(commands).not.toContain('checkout_draft_inspect');
    expect(commands).not.toContain('checkout_draft_delete');
    expect(accepted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByText('Return to orders') as HTMLButtonElement).disabled).toBe(true);
    mocks.readError = false;
    fireEvent.click(screen.getByText('Check original checkout'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(freezeNotSaved));
    expect(draftStorage.draft).toMatchObject({ checkoutRequestId: originalId, phase: 'editing' });
    expect(accepted).not.toHaveBeenCalled();
    expect(draftStorage.deletes).toBe(0);
  });

  it('a freeze that did commit after all stays with recovery and is never returned to the cart', async () => {
    const accepted = vi.fn(async () => true);
    mocks.settings.unavailable = false;
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={accepted} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    // The write commits, but its answer is lost.
    mocks.freezeAckLost = true;
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('checkout_pending'));
    await screen.findByText('Check original checkout');
    expect(mocks.toastError).not.toHaveBeenCalledWith(freezeNotSaved);
    expect(draftStorage.draft.state.paymentAdmission).toBe('admitted');
  });

  // Tomikro 22/10/2026: native read full-precision floats back a bit off, so
  // every cash confirmation of a delivery was refused after the money was
  // taken, for 12 minutes. Float noise is no change to the checkout.
  it('a cash checkout whose floats native reads back a bit off completes once', async () => {
    const accepted = vi.fn(async () => true);
    mocks.readbackChange = draft => JSON.parse(JSON.stringify(draft), (key, item) =>
      typeof item === 'number' && key !== 'schemaVersion' && item !== 0 ? item * (1 + Number.EPSILON) : item);
    mocks.settings.unavailable = false;
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={accepted} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    expect(draftStorage.draft.cartItems[0].quantity).not.toBe(1);
    const originalId = draftStorage.draft.checkoutRequestId;
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(accepted.mock.calls[0][0]).toMatchObject({ clientRequestId: originalId, paymentData: { method: 'cash' } });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('a freeze native keeps differently returns the editable cart before any money moves, with its reason', async () => {
    const accepted = vi.fn(async () => true);
    mocks.settings.unavailable = false;
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={accepted} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    const originalId = draftStorage.draft.checkoutRequestId;
    mocks.readbackChange = draft => draft.phase === 'checkout_pending'
      ? { ...draft, cartItems: draft.cartItems.map((item: any) => ({ ...item, notes: 'changed by storage' })) } : draft;
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      'No payment was started: the till could not save this cart for payment exactly as entered. Select the customer or address again, then press Pay. If it happens again, contact support.'));
    expect(accepted).not.toHaveBeenCalled();
    expect(screen.queryByText('Check original checkout')).toBeNull();
    expect(draftStorage.draft).toMatchObject({ checkoutRequestId: originalId, phase: 'editing' });
    expect(draftStorage.draft.cartItems[0].notes).not.toBe('changed by storage');
    mocks.readbackChange = null;
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(accepted.mock.calls[0][0]).toMatchObject({ clientRequestId: originalId, paymentData: { method: 'cash' } });
  });

  it('a confirmation the saved checkout refuses gives its reason, not "press Pay again"', async () => {
    const accepted = vi.fn(async () => true);
    mocks.settings.unavailable = false;
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={accepted} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash for another amount'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('pressing Pay again as it is will not help'), expect.anything()));
    expect(mocks.toastError).not.toHaveBeenCalledWith(expect.stringContaining('The cart is kept: press Pay again'), expect.anything());
    expect(accepted).not.toHaveBeenCalled();
    expect(draftStorage.draft).toMatchObject({ phase: 'editing' });
  });
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

  // Tomikro 25-26/10/2026: "Refresh the order" never re-read the server and
  // every retry was refused the same way. The refusal now offers a real refresh.
  it.each(['EDIT_CANONICAL_ORIGINAL_CHANGED', 'ORDER_VERSION_CONFLICT'])('a refused correction (%s) offers a refresh from the server, then reopens the order', async (code) => {
    mocks.refreshFromServer.mockClear();
    const commit = vi.fn();
    const close = await openEdit(commit, vi.fn(), 'collect', { preflight: async () => { throw new Error(code); } });
    const refresh = await screen.findByTestId('menu-edit-refresh-order');
    expect(screen.getByTestId('menu-edit-stale').textContent).toContain('modals.menu.editCanonicalChanged');
    fireEvent.click(refresh);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(mocks.refreshFromServer).toHaveBeenCalledWith('paid-order');
    expect(commit).not.toHaveBeenCalled();
    // Nothing was charged; the cart built on the old order is let go.
    expect(draftStorage.draft).toBeNull();
  });

  it('a failed refresh keeps the editor and says what to do', async () => {
    mocks.toastError.mockClear();
    mocks.refreshFromServer.mockImplementationOnce(async () => { throw new Error('EDIT_PREVIOUS_SETTLEMENT_SYNC_REQUIRED'); });
    const close = await openEdit(vi.fn(), vi.fn(), 'collect', { preflight: async () => { throw new Error('EDIT_ORIGINAL_ITEMS_UNAVAILABLE'); } });
    fireEvent.click(await screen.findByTestId('menu-edit-refresh-order'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('modals.menu.editRefreshFailed'));
    expect(close).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
  });

  it('an order the till refreshed from the server closes the editor with a reopen message', async () => {
    mocks.toastError.mockClear();
    const close = await openEdit(vi.fn(), vi.fn(), 'collect', { preflight: async () => { throw new Error('EDIT_ORDER_REFRESHED'); } });
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('modals.menu.editOrderRefreshed'));
    expect(close).toHaveBeenCalledOnce();
    expect(draftStorage.draft).toBeNull();
  });

  it('a refusal the renderer decides is reported once with its field name', async () => {
    mocks.reportEditRefusal.mockClear();
    await openEdit(vi.fn(), vi.fn(), 'collect', {
      preflight: async () => { throw new RendererEditRefusal('EDIT_CANONICAL_QUOTE_CHANGED', 'quote_financials'); },
    });
    await waitFor(() => expect(mocks.reportEditRefusal).toHaveBeenCalledWith({ refusal: 'EDIT_CANONICAL_QUOTE_CHANGED', field: 'quote_financials' }));
    expect(mocks.reportEditRefusal).toHaveBeenCalledOnce();
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
    // 1.4.125: the unsubmitted correction is discarded before the menu closes.
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(draftStorage.draft).toBeNull();
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

// 1.4.125, stuck edit. Closing an order correction kept its draft
// (context.editMode), so every new order reopened the same edit screen, also
// after a restart. An unsubmitted correction is now discarded on close; a
// correction with a submitted financial step stays protected.
describe('MenuModal closing an order correction (1.4.125)', () => {
  const editLine = { id: 'original-line', menuItemId: 'espresso', name: 'Espresso', quantity: 1, unitPrice: 6, totalPrice: 6, price: 6 };
  const editContext = { editMode: true, editOrderId: 'paid-order', editExpectedVersion: 1, orderType: 'pickup' };
  const loadEditOrder = () => {
    mocks.settings.unavailable = false;
    mocks.editOrder = { id: 'paid-order', version: 1, order_type: 'pickup', items: [
      { id: 'original-line', menu_item_id: 'espresso', name: 'Espresso', quantity: 1, unit_price: 6, total_price: 6 },
    ] };
  };
  const closeButton = () => screen.getByRole('button', { name: 'common.actions.close' });

  it('discards an unsubmitted correction before closing, so the next new order does not reopen it', async () => {
    loadEditOrder();
    let draftAtClose: any = 'not closed';
    const onClose = vi.fn(() => { draftAtClose = draftStorage.draft; });
    const view = render(<MenuModal isOpen onClose={onClose} orderType="pickup" editMode editOrderId="paid-order" />);
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    expect(draftStorage.draft).toMatchObject({ phase: 'editing', context: { editMode: true, editOrderId: 'paid-order' } });
    expect(draftStorage.draft.submission).toBeUndefined();
    fireEvent.click(closeButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(draftStorage.deletes).toBe(1);
    expect(draftAtClose).toBeNull();
    expect(draftStorage.draft).toBeNull();

    // The parent opens the menu for a new order: nothing restores the edit.
    const restore = vi.fn();
    view.rerender(<MenuModal isOpen={false} onClose={onClose} orderType="pickup" />);
    view.rerender(<MenuModal isOpen onClose={onClose} orderType="pickup" onDraftRestore={restore} />);
    await waitFor(() => {
      expect(screen.queryByText('Loading the saved cart…')).toBeNull();
      expect(screen.queryByText('modals.menu.draftSaveFailed')).toBeNull();
    });
    expect(restore).not.toHaveBeenCalled();
    expect(draftStorage.draft).toMatchObject({ phase: 'editing', cartItems: [], context: { editMode: false } });
  });

  it('keeps a submitted (checkout_pending) correction and just closes', async () => {
    loadEditOrder();
    const frozen = { schemaVersion: 1, draftId: 'frozen-edit', checkoutRequestId: 'frozen-attempt', phase: 'checkout_pending',
      cartItems: [editLine], state: {}, context: editContext,
      submission: { action: 'edit_settlement', orderId: 'paid-order', client_event_id: 'frozen-attempt' } };
    draftStorage.generation = 5;
    draftStorage.draft = structuredClone(frozen);
    const onClose = vi.fn();
    render(<MenuModal isOpen onClose={onClose} orderType="pickup" editMode editOrderId="paid-order" />);
    await screen.findByText('Check original checkout');
    fireEvent.click(closeButton());
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { await Promise.resolve(); });
    expect(draftStorage.deletes).toBe(0);
    expect(draftStorage.generation).toBe(5);
    expect(draftStorage.draft).toEqual(frozen);
  });

  it('keeps a renewed refused correction, which replaces an attempt the journal still holds', async () => {
    loadEditOrder();
    draftStorage.generation = 5;
    draftStorage.draft = { schemaVersion: 1, draftId: 'renewed-edit', checkoutRequestId: 'renewed-attempt', phase: 'editing',
      cartItems: [editLine], state: {}, context: { ...editContext, supersedesEditEvent: 'refused-attempt' } };
    const onClose = vi.fn();
    render(<MenuModal isOpen onClose={onClose} orderType="pickup" editMode editOrderId="paid-order" />);
    await waitFor(() => expect(screen.queryByText('Loading the saved cart…')).toBeNull());
    fireEvent.click(closeButton());
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { await Promise.resolve(); });
    expect(draftStorage.deletes).toBe(0);
    expect(draftStorage.draft).toMatchObject({ draftId: 'renewed-edit', phase: 'editing',
      context: { editMode: true, supersedesEditEvent: 'refused-attempt' } });
  });

  // Review of PR #335: closing while the persisted edit draft was still
  // loading called onClose() without the tombstone, so the edit reopened later.
  it('a close while the saved correction is still loading waits for it, discards it, then closes', async () => {
    loadEditOrder();
    draftStorage.generation = 5;
    draftStorage.draft = { schemaVersion: 1, draftId: 'kept-edit', checkoutRequestId: 'kept-attempt', phase: 'editing',
      cartItems: [editLine], state: {}, context: editContext };
    let finishLoad!: () => void;
    draftStorage.loadGate = new Promise<void>(resolve => { finishLoad = resolve; });
    let draftAtClose: any = 'not closed';
    const onClose = vi.fn(() => { draftAtClose = draftStorage.draft; });
    render(<MenuModal isOpen onClose={onClose} orderType="pickup" editMode editOrderId="paid-order" />);
    fireEvent.click(closeButton());
    await act(async () => { await Promise.resolve(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(draftStorage.deletes).toBe(0);

    await act(async () => { finishLoad(); });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(draftStorage.deletes).toBe(1);
    expect(draftAtClose).toBeNull();
    expect(draftStorage.draft).toBeNull();
  });

  it('a close while a submitted correction is still loading keeps it and just closes', async () => {
    loadEditOrder();
    const frozen = { schemaVersion: 1, draftId: 'frozen-edit', checkoutRequestId: 'frozen-attempt', phase: 'checkout_pending',
      cartItems: [editLine], state: {}, context: editContext,
      submission: { action: 'edit_settlement', orderId: 'paid-order', client_event_id: 'frozen-attempt' } };
    draftStorage.generation = 5;
    draftStorage.draft = structuredClone(frozen);
    let finishLoad!: () => void;
    draftStorage.loadGate = new Promise<void>(resolve => { finishLoad = resolve; });
    const onClose = vi.fn();
    render(<MenuModal isOpen onClose={onClose} orderType="pickup" editMode editOrderId="paid-order" />);
    fireEvent.click(closeButton());
    await act(async () => { finishLoad(); });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(draftStorage.deletes).toBe(0);
    expect(draftStorage.draft).toEqual(frozen);
  });

  it('retains the correction and stays open when the discard cannot be stored', async () => {
    loadEditOrder();
    draftStorage.deleteError = true;
    const onClose = vi.fn();
    render(<MenuModal isOpen onClose={onClose} orderType="pickup" editMode editOrderId="paid-order" />);
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    fireEvent.click(closeButton());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('The saved cart could not be discarded. It has been retained.'));
    expect(onClose).not.toHaveBeenCalled();
    expect(draftStorage.draft).toMatchObject({ phase: 'editing', context: { editMode: true } });
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

  it('keeps the original correction protected when its recovery snapshot cannot be confirmed', async () => {
    editOrder([{ id: 'original-line', menu_item_id: 'espresso', name: 'Espresso', quantity: 1, unit_price: 6, total_price: 6 }]);
    refusedDraft();
    mocks.recoverySnapshot.mockResolvedValue(null);
    const complete = vi.fn();
    const close = vi.fn();
    render(<MenuModal isOpen onClose={close} orderType="pickup" editMode editOrderId="paid-order"
      onEditPreflight={vi.fn(async () => ({ kind: 'ordinary' as const }))} onEditComplete={complete} />);
    fireEvent.click(await screen.findByText('Check original checkout'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('The original checkout could not be verified. Its saved cart remains protected.'));
    expect(complete).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(mocks.applyEditSettlement).not.toHaveBeenCalled();
    expect(draftStorage.draft.phase).toBe('checkout_pending');
    expect(draftStorage.draft.checkoutRequestId).toBe('refused-event');
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
    // 08/10/2026: shown as the generic "Failed to save changes" before 1.4.125.
    ['EDIT_ORIGINAL_PROVIDER_REFUND_REQUIRED', 'modals.menu.editProviderRefundRequired'],
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


describe('coupon and loyalty checkout admission', () => {
  it('removes the coupon and recomputes the discount when the qualifying basket shrinks', async () => {
    mocks.settings.unavailable = false;
    renderMenu();
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Apply coupon'));
    await waitFor(() => expect(screen.getByTestId('applied-coupon').textContent).toBe('SAVE'));
    expect(screen.getByTestId('coupon-discount').textContent).toBe('1.6');
    fireEvent.click(screen.getByText('Remove first item'));
    await waitFor(() => expect(screen.getByTestId('applied-coupon').textContent).toBe('none'));
    expect(screen.getByTestId('coupon-discount').textContent).toBe('0');
    expect(mocks.toastError).toHaveBeenCalledWith("Your order doesn't meet this coupon's minimum amount");
  });

  it.each(['cash', 'split'])('rechecks a coupon that expires while the payment picker is open (%s)', async method => {
    mocks.settings.unavailable = false;
    mocks.coupon.min_order_amount = 0;
    mocks.coupon.expires_at = new Date(Date.now() + 60000).toISOString();
    const complete = vi.fn();
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={complete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Apply coupon'));
    await waitFor(() => expect(screen.getByTestId('applied-coupon').textContent).toBe('SAVE'));
    fireEvent.click(screen.getByText('Checkout'));
    await screen.findByTestId('payment-modal');
    // Time passes without a basket update or a render that would remove it.
    const later = Date.now() + 120000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    fireEvent.click(screen.getByText(method === 'cash' ? 'Confirm cash' : 'Confirm split'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('This coupon has expired'));
    expect(complete).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
  });

  it('a refused loyalty debit keeps the cart editable and removes the prepared discount before save', async () => {
    mocks.settings.unavailable = false;
    mocks.loyaltyEnabled = true;
    mocks.redeem.mockRejectedValue(new Error('Insufficient balance'));
    const complete = vi.fn();
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" selectedCustomer={{ id: '11111111-1111-4111-8111-111111111111', name: 'Customer' }} onOrderComplete={complete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Redeem points'));
    fireEvent.click(await screen.findByText('Use 100 points'));
    await waitFor(() => expect(screen.getByTestId('loyalty-applied').textContent).toBe('100'));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('loyalty.checkoutRefused'));
    expect(complete).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
    expect(screen.getByTestId('loyalty-applied').textContent).toBe('0');
  });

  // Ω11 (22/10/2026): points are redeemed only with a live server answer.
  it('offline: the points come off with their own message and the sale continues', async () => {
    mocks.settings.unavailable = false;
    mocks.loyaltyEnabled = true;
    mocks.redeem.mockResolvedValue({ success: false, errorCode: 'LOYALTY_REDEEM_OFFLINE' });
    const complete = vi.fn();
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" selectedCustomer={{ id: '11111111-1111-4111-8111-111111111111', name: 'Customer' }} onOrderComplete={complete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Redeem points'));
    fireEvent.click(await screen.findByText('Use 100 points'));
    await waitFor(() => expect(screen.getByTestId('loyalty-applied').textContent).toBe('100'));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('loyalty.redeem.offlineRefused'));
    expect(complete).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
    expect(screen.getByTestId('loyalty-applied').textContent).toBe('0');
  });

  it('unconfirmed: the points stay, nothing is collected, and Retry or Remove points decides', async () => {
    mocks.settings.unavailable = false;
    mocks.loyaltyEnabled = true;
    mocks.redeem.mockResolvedValue({ success: false, errorCode: 'LOYALTY_REDEEM_UNCONFIRMED' });
    const complete = vi.fn();
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" selectedCustomer={{ id: '11111111-1111-4111-8111-111111111111', name: 'Customer' }} onOrderComplete={complete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Redeem points'));
    fireEvent.click(await screen.findByText('Use 100 points'));
    await waitFor(() => expect(screen.getByTestId('loyalty-applied').textContent).toBe('100'));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      expect.any(Function), expect.objectContaining({ id: 'loyalty-redemption-unconfirmed' })));
    expect(complete).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
    expect(screen.getByTestId('loyalty-applied').textContent).toBe('100');
    expect(screen.getByTestId('payment-modal')).toBeTruthy();
    const unconfirmed = mocks.toastError.mock.calls.find(([, options]) => options?.id === 'loyalty-redemption-unconfirmed');
    const renderToast = () => render(<>{unconfirmed![0]({ id: 'loyalty-redemption-unconfirmed' })}</>).container;

    // Retry asks again under the same checkout; still no answer keeps the points.
    fireEvent.click(within(renderToast()).getByText('common.actions.retry'));
    await waitFor(() => expect(mocks.redeem).toHaveBeenCalledTimes(2));
    expect(mocks.redeem.mock.calls[1][0]).toEqual(mocks.redeem.mock.calls[0][0]);
    expect(screen.getByTestId('loyalty-applied').textContent).toBe('100');

    // Remove points releases them and returns to the cart without the discount.
    fireEvent.click(within(renderToast()).getByText('loyalty.redeem.removePoints'));
    await waitFor(() => expect(screen.getByTestId('loyalty-applied').textContent).toBe('0'));
    await waitFor(() => expect(screen.queryByTestId('payment-modal')).toBeNull());
    expect(mocks.toastError).not.toHaveBeenCalledWith('loyalty.redeem.releaseFailed');
    expect(complete).not.toHaveBeenCalled();
  });
});


it.each([['Admit QR', 'Confirm TWINT receipt', 'twint'], ['Admit card', 'Complete approved card', 'card']])('retains the frozen coupon total after payment admission: %s', async (admit, confirm, method) => {
  mocks.settings.unavailable = false;
  mocks.coupon.min_order_amount = 0;
  mocks.coupon.expires_at = new Date(Date.now() + 60000).toISOString();
  const complete = vi.fn(async submission => {
    expect(draftStorage.draft.phase).toBe('checkout_pending');
    expect(draftStorage.draft.submission).toEqual(JSON.parse(JSON.stringify(submission)));
    return true;
  });
  render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={complete} />);
  await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
  fireEvent.click(screen.getByText('Add espresso'));
  fireEvent.click(screen.getByText('Apply coupon'));
  await waitFor(() => expect(screen.getByTestId('applied-coupon').textContent).toBe('SAVE'));
  fireEvent.click(screen.getByText('Checkout'));
  fireEvent.click(await screen.findByText(admit));
  await waitFor(() => expect(draftStorage.draft?.phase).toBe('checkout_pending'));
  expect(draftStorage.draft.submission).toMatchObject({ total: 7.2, coupon_discount_amount: 0.8, total_discount_amount: 0.8, paymentData: { method, amount: 7.2 } });
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
  fireEvent.click(screen.getByText(confirm));
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ total: 7.2, coupon_code: 'SAVE', coupon_discount_amount: 0.8, total_discount_amount: 0.8, paymentData: expect.objectContaining({ method, amount: 7.2 }) }));
  expect(mocks.toastError).not.toHaveBeenCalledWith('This coupon has expired');
});


it('does not redeem loyalty again after the admitted QR receipt is confirmed', async () => {
  mocks.settings.unavailable = false;
  mocks.loyaltyEnabled = true;
  const complete = vi.fn(async () => true);
  render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" selectedCustomer={{ id: '11111111-1111-4111-8111-111111111111', name: 'Customer' }} onOrderComplete={complete} />);
  await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
  fireEvent.click(screen.getByText('Add espresso'));
  fireEvent.click(screen.getByText('Redeem points'));
  fireEvent.click(await screen.findByText('Use 100 points'));
  await waitFor(() => expect(screen.getByTestId('loyalty-applied').textContent).toBe('100'));
  fireEvent.click(screen.getByText('Checkout'));
  fireEvent.click(await screen.findByText('Admit loyalty QR'));
  await waitFor(() => expect(draftStorage.draft?.phase).toBe('checkout_pending'));
  expect(mocks.redeem).toHaveBeenCalledOnce();
  mocks.redeem.mockRejectedValue(new Error('Program disabled after the customer paid'));
  fireEvent.click(screen.getByText('Confirm loyalty receipt'));
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(mocks.redeem).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ total: 7, loyalty_discount_amount: 1, loyalty_checkout_secured: true }));
});


it('recovers the confirmed original TWINT receipt after confirmation persistence failed, without a new admission', async () => {
  mocks.settings.unavailable = false;
  mocks.coupon.min_order_amount = 0;
  mocks.coupon.expires_at = new Date(Date.now() + 60000).toISOString();
  const complete = vi.fn(async () => true);
  render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={complete} />);
  await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
  fireEvent.click(screen.getByText('Add espresso'));
  fireEvent.click(screen.getByText('Apply coupon'));
  await waitFor(() => expect(screen.getByTestId('applied-coupon').textContent).toBe('SAVE'));
  fireEvent.click(screen.getByText('Checkout'));
  fireEvent.click(await screen.findByText('Admit QR'));
  await waitFor(() => expect(draftStorage.draft?.phase).toBe('checkout_pending'));
  const originalId = draftStorage.draft.checkoutRequestId;
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
  mocks.confirmationFreezeError = true;
  fireEvent.click(screen.getByText('Confirm TWINT receipt'));
  await screen.findByText('modals.menu.draftSaveFailed');
  expect(complete).not.toHaveBeenCalled();
  mocks.confirmationFreezeError = false;
  fireEvent.click(screen.getByText('Check original checkout'));
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ clientRequestId: originalId, total: 7.2, coupon_discount_amount: 0.8,
    paymentData: expect.objectContaining({ method: 'twint', amount: 7.2, idempotencyKey: 'admitted-twint' }) }));
});


// Tomikro 21/10/2026: the till closed during a card payment. The draft stayed
// `checkout_pending` with the admission `admitted`, and the till had no order,
// no terminal row and no held payment for it. "Check original checkout" only
// said "needs reconciliation", and the single draft slot reopened that frozen
// checkout for every new order. The cashier now answers what the bank POS
// shows; whatever recovery still cannot settle, a manager parks.
describe('a card admission frozen across a restart (Tomikro 21/10/2026)', () => {
  const cardChargeConfirmable = { success: true, outcome: 'not_found', canCollect: false, cashierCanConfirmCard: true };

  async function freezeAdmittedCard(complete: any) {
    mocks.settings.unavailable = false;
    const first = render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={complete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Admit card'));
    await waitFor(() => expect(draftStorage.draft?.state.paymentAdmission).toBe('admitted'));
    const original = JSON.parse(JSON.stringify(draftStorage.draft.submission));
    first.unmount();
    return original;
  }

  const reopen = (complete: any, onClose = vi.fn(), extra: Record<string, any> = {}) =>
    render(<MenuModal isOpen onClose={onClose} orderType="pickup" onOrderComplete={complete} {...extra} />);

  it('asks whether the card was charged instead of a dead end: not charged returns the editable cart', async () => {
    mocks.inspect = cardChargeConfirmable;
    const complete = vi.fn(async () => true);
    const original = await freezeAdmittedCard(complete);
    reopen(complete);
    fireEvent.click(await screen.findByText('Check original checkout'));
    fireEvent.click(await screen.findByTestId('card-recover-not-charged'));
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    expect(draftStorage.draft.submission).toBeUndefined();
    expect(draftStorage.draft.checkoutRequestId).toBe(original.clientRequestId);
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalledWith('The original checkout still needs reconciliation. No new payment was started. Use payment recovery or ask a manager.');
    // The till takes the order again.
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ clientRequestId: original.clientRequestId, paymentData: expect.objectContaining({ method: 'cash' }) }));
  });

  it('charged records the original card request once as collected, with no terminal step, and the next order starts fresh', async () => {
    mocks.inspect = cardChargeConfirmable;
    const complete = vi.fn(async () => true);
    const onClose = vi.fn();
    const original = await freezeAdmittedCard(complete);
    const second = reopen(complete, onClose);
    fireEvent.click(await screen.findByText('Check original checkout'));
    fireEvent.click(await screen.findByTestId('card-recover-charged'));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(complete).toHaveBeenCalledWith({ ...original, paymentData: { ...original.paymentData,
      metadata: { confirmation: 'cashier', confirmation_action: 'card_charged_outside_till' } } });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(draftStorage.draft).toBeNull();
    expect(vi.mocked(getBridge().invoke).mock.calls.map(call => call[0])).not.toContain('ecr_process_payment');
    second.unmount();
    reopen(complete);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    expect(screen.queryByText('Check original checkout')).toBeNull();
    expect(draftStorage.draft.checkoutRequestId).not.toBe(original.clientRequestId);
  });

  it('never offers "charged" when this till charges cards through its cash register, or when evidence exists', async () => {
    const complete = vi.fn(async () => true);
    await freezeAdmittedCard(complete);
    mocks.inspect = { success: true, outcome: 'not_found', canCollect: false, cashierCanConfirmCard: false };
    const second = reopen(complete);
    fireEvent.click(await screen.findByText('Check original checkout'));
    await screen.findByTestId('card-recover-not-charged');
    expect(screen.queryByTestId('card-recover-charged')).toBeNull();
    second.unmount();
    mocks.inspect = { success: true, outcome: 'uncertain', canCollect: false, cashierCanConfirmCard: true, ecr: [{ id: 'sale', status: 'processing' }] };
    reopen(complete);
    fireEvent.click(await screen.findByText('Check original checkout'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('The original checkout still needs reconciliation. No new payment was started. Use payment recovery or ask a manager.'));
    expect(screen.queryByTestId('card-recover-charged')).toBeNull();
    expect(screen.queryByTestId('card-recover-not-charged')).toBeNull();
    await screen.findByTestId('checkout-park');
    expect(complete).not.toHaveBeenCalled();
  });

  it('a manager parks an attempt recovery cannot settle, and the till takes new orders under a new identity', async () => {
    const complete = vi.fn(async () => true);
    const onClose = vi.fn();
    const onCheckoutParked = vi.fn();
    const original = await freezeAdmittedCard(complete);
    mocks.inspect = { success: true, outcome: 'uncertain', canCollect: false, ecr: [{ id: 'sale', status: 'processing' }] };
    const second = reopen(complete, onClose, { onCheckoutParked });
    fireEvent.click(await screen.findByText('Check original checkout'));
    fireEvent.click(await screen.findByTestId('checkout-park'));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const park = vi.mocked(getBridge().invoke).mock.calls.find(call => call[0] === 'checkout_draft_park');
    expect(park?.[1]).toMatchObject({ organizationId: 'org-1', branchId: 'branch-1', terminalId: 'terminal-1',
      draftId: expect.any(String), clientRequestId: original.clientRequestId, expectedGeneration: expect.any(Number) });
    expect(draftStorage.parked).toMatchObject({ checkoutRequestId: original.clientRequestId, phase: 'checkout_pending' });
    expect(draftStorage.draft).toBeNull();
    expect(onCheckoutParked).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    second.unmount();
    mocks.inspect = null;
    reopen(complete);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    expect(screen.queryByText('Check original checkout')).toBeNull();
    fireEvent.click(screen.getByText('Add espresso'));
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect((complete.mock.calls[0] as any[])[0].clientRequestId).not.toBe(original.clientRequestId);
  });

  it('a refused park keeps the frozen checkout and parks nothing', async () => {
    const complete = vi.fn(async () => true);
    const onClose = vi.fn();
    const original = await freezeAdmittedCard(complete);
    mocks.inspect = { success: true, outcome: 'held', canCollect: false, payments: [] };
    draftStorage.parkError = 'CHECKOUT_DRAFT_PARK_NOT_NEEDED';
    reopen(complete, onClose);
    fireEvent.click(await screen.findByText('Check original checkout'));
    fireEvent.click(await screen.findByTestId('checkout-park'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('The checkout could not be set aside. It stays protected; nothing was changed.'));
    expect(onClose).not.toHaveBeenCalled();
    expect(draftStorage.parked).toBeNull();
    expect(draftStorage.draft).toMatchObject({ checkoutRequestId: original.clientRequestId, phase: 'checkout_pending' });
  });
});

// Tomikro 21/10/2026, the first half: the order write failed before anything
// existed and the admitted checkout stayed frozen. Money no provider collects
// returns to the editable cart under the same identity; a provider's attempt
// stays protected for recovery.
describe('an order write that fails before anything exists (Tomikro 21/10/2026)', () => {
  const notSaved = 'The order was not saved and no payment was recorded. The cart is kept: press Pay again. If you already took the money, do not take it again.';

  async function payAndFail(button: string, complete: any) {
    mocks.settings.unavailable = false;
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={complete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    await waitFor(() => expect(draftStorage.draft?.cartItems).toHaveLength(1));
    const identity = draftStorage.draft.checkoutRequestId;
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText(button));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    return identity;
  }

  it.each([
    ['refused', 'Confirm cash', async () => false],
    ['threw', 'Confirm cash', async () => { throw new Error('ORDER_WRITE_FAILED'); }],
    ['refused', 'Confirm card', async () => false],
  ])('a %s write (%s) returns the editable cart and the retry reuses the same identity', async (_kind, button, failure) => {
    mocks.inspect = { success: true, outcome: 'not_found', canCollect: false, cashierCanConfirmCard: true, checkoutInProgress: false };
    const complete = vi.fn(failure as any);
    const identity = await payAndFail(button, complete);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    expect(draftStorage.draft.submission).toBeUndefined();
    expect(draftStorage.draft.checkoutRequestId).toBe(identity);
    expect(mocks.toastError).toHaveBeenCalledWith(notSaved, expect.anything());
    expect(screen.queryByText('Check original checkout')).toBeNull();
    complete.mockImplementation(async () => true);
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText(button));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect((complete.mock.calls[1] as any[])[0].clientRequestId).toBe(identity);
  });

  it('keeps a card protected where the cash register charges cards, and while a press still runs', async () => {
    mocks.inspect = { success: true, outcome: 'not_found', canCollect: false, cashierCanConfirmCard: false, checkoutInProgress: false };
    const complete = vi.fn(async () => false);
    const first = await payAndFail('Confirm card', complete);
    await waitFor(() => expect(draftStorage.draft?.state.paymentAdmission).toBe('confirmed'));
    expect(draftStorage.draft).toMatchObject({ phase: 'checkout_pending', checkoutRequestId: first });
    expect(mocks.toastError).not.toHaveBeenCalledWith(notSaved, expect.anything());
    cleanup();
    draftStorage.draft = null; draftStorage.generation = 0;
    mocks.inspect = { success: true, outcome: 'not_found', canCollect: false, cashierCanConfirmCard: true, checkoutInProgress: true };
    const running = vi.fn(async () => false);
    await payAndFail('Confirm cash', running);
    await waitFor(() => expect(draftStorage.draft?.state.paymentAdmission).toBe('confirmed'));
    expect(draftStorage.draft.phase).toBe('checkout_pending');
    expect(mocks.toastError).not.toHaveBeenCalledWith(notSaved, expect.anything());
  });

  it('never releases a TWINT receipt the customer already paid', async () => {
    mocks.settings.unavailable = false;
    mocks.inspect = { success: true, outcome: 'not_found', canCollect: false, cashierCanConfirmCard: true, checkoutInProgress: false };
    const complete = vi.fn(async () => false);
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={complete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Admit QR'));
    await waitFor(() => expect(draftStorage.draft?.state.paymentAdmission).toBe('admitted'));
    fireEvent.click(screen.getByText('Confirm TWINT receipt'));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await waitFor(() => expect(draftStorage.draft?.state.paymentAdmission).toBe('confirmed'));
    expect(draftStorage.draft.phase).toBe('checkout_pending');
    expect(mocks.toastError).not.toHaveBeenCalledWith(notSaved, expect.anything());
  });

  it('after a restart, a card the app had confirmed but never wrote still gets the cashier question', async () => {
    mocks.settings.unavailable = false;
    mocks.inspect = { success: true, outcome: 'not_found', canCollect: false, cashierCanConfirmCard: false, checkoutInProgress: false };
    const complete = vi.fn(async () => false);
    const first = render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={complete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm card'));
    await waitFor(() => expect(draftStorage.draft?.state.paymentAdmission).toBe('confirmed'));
    first.unmount();
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" onOrderComplete={complete} />);
    fireEvent.click(await screen.findByText('Check original checkout'));
    fireEvent.click(await screen.findByTestId('card-recover-not-charged'));
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    expect(draftStorage.draft.submission).toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
  });
});

it.each(['paid', 'not-paid'])('recovers an unconfirmed TWINT admission after restart: %s', async decision => {
  mocks.settings.unavailable = false;
  mocks.loyaltyEnabled = true;
  const customer = { id: '11111111-1111-4111-8111-111111111111', name: 'Customer' };
  const complete = vi.fn(async () => true);
  const first = render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" selectedCustomer={customer} onOrderComplete={complete} />);
  await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
  fireEvent.click(screen.getByText('Add espresso'));
  fireEvent.click(screen.getByText('Redeem points'));
  fireEvent.click(await screen.findByText('Use 100 points'));
  await waitFor(() => expect(screen.getByTestId('loyalty-applied').textContent).toBe('100'));
  fireEvent.click(screen.getByText('Checkout'));
  fireEvent.click(await screen.findByText('Admit loyalty QR'));
  await waitFor(() => expect(draftStorage.draft?.state.paymentAdmission).toBe('admitted'));
  const original = JSON.parse(JSON.stringify(draftStorage.draft.submission));
  expect(mocks.redeem).toHaveBeenCalledOnce();
  first.unmount();
  render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" selectedCustomer={customer} onOrderComplete={complete} />);
  fireEvent.click(await screen.findByTestId(decision === 'paid' ? 'twint-recover-paid' : 'twint-recover-not-paid'));
  if (decision === 'paid') {
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(complete).toHaveBeenCalledWith({ ...original, paymentData: { ...original.paymentData,
      metadata: { provider: 'twint', confirmation: 'cashier', confirmation_action: 'confirm' } } });
    expect(draftStorage.draft).toBeNull();
    expect(mocks.redeem).toHaveBeenCalledOnce();
  } else {
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    expect(draftStorage.draft.submission).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    expect(getBridge().invoke).toHaveBeenCalledWith('loyalty_release_redemption', { arg0: { orderId: original.clientRequestId } });
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(mocks.redeem).toHaveBeenCalledTimes(2);
  }
});

// Codex review of PR #379 (22/10/2026): an appointment's checkout claim is
// renewed right before money moves; a refusal starts no payment and the cart
// stays editable (as on Android).
describe('appointment checkout claim before payment', () => {
  it('a renewal that no longer allows the checkout collects nothing and returns to the editable cart', async () => {
    mocks.settings.unavailable = false;
    mocks.appointmentClaims.mockResolvedValue({ appointmentId: 'appointment-1', outcome: { kind: 'needs_connection' } });
    const complete = vi.fn();
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" selectedCustomer={customer} onOrderComplete={complete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      'Checking out an appointment needs a connection. You can sell the services as a walk-in.'));
    expect(mocks.appointmentClaims).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: expect.anything() })]));
    expect(complete).not.toHaveBeenCalled();
    expect(draftStorage.draft?.phase).toBe('editing');
    expect(screen.queryByTestId('payment-modal')).toBeNull();
  });

  it('a renewal that still allows the checkout goes on to the payment', async () => {
    mocks.settings.unavailable = false;
    const complete = vi.fn();
    render(<MenuModal isOpen onClose={vi.fn()} orderType="pickup" selectedCustomer={customer} onOrderComplete={complete} />);
    await waitFor(() => expect(draftStorage.draft?.phase).toBe('editing'));
    fireEvent.click(screen.getByText('Add espresso'));
    fireEvent.click(screen.getByText('Checkout'));
    fireEvent.click(await screen.findByText('Confirm cash'));
    await waitFor(() => expect(complete).toHaveBeenCalled());
    expect(mocks.appointmentClaims).toHaveBeenCalledTimes(1);
  });
});
