import { describe, expect, it } from 'vitest';
import { editRefusalMessageKey } from '../editRefusalMessage';
import en from '../../../locales/en.json';
import el from '../../../locales/el.json';
import de from '../../../locales/de.json';
import fr from '../../../locales/fr.json';
import itLocale from '../../../locales/it.json';
import sq from '../../../locales/sq.json';

describe('edit refusal guidance', () => {
  it.each([
    ['EDIT_DISCARD_MONEY_DECLARED', 'editDiscardMoneyGuidance'],
    ['EDIT_DISCARD_PROVIDER_CHECK_REQUIRED', 'editDiscardProviderCheck'],
  ] as const)('%s explains why discard is unavailable in every locale', (code, key) => {
    expect(editRefusalMessageKey(code)).toBe(key);
    for (const locale of [en, el, de, fr, itLocale, sq]) {
      expect(locale.modals.menu[key].length).toBeGreaterThan(40);
      expect(locale.modals.menu[key]).not.toMatch(/\?{2}|\uFFFD/);
    }
  });
  it.each([
    ['SHIFT_CURRENCY_UNAVAILABLE', 'editCurrencyUnavailable'],
    ['PAYMENT_CURRENCY_UNAVAILABLE', 'editCurrencyUnavailable'],
    ['ORDER_CURRENCY_MISMATCH', 'editCurrencyMismatch'],
    ['PAYMENT_COLLECTOR_STAFF_MISMATCH', 'editCollectorUnavailable'],
    ['CASHIER_REQUIRED', 'editCollectorUnavailable'],
    ['EDIT_NO_DRAWER_OWNER_ON_SHIFT', 'editNoDrawerOwnerOnShift'],
    ['EDIT_COLLECTION_AMOUNT_MISMATCH', 'editPaymentMismatch'],
    ['EDIT_LOCAL_OPERATION_FAILED', 'editLocalOperationFailed'],
    ['EDIT_SETTLEMENT_OUTCOME_UNKNOWN', 'editLocalOperationFailed'],
    ['CHECKOUT_DRAFT_SCOPE_CHANGED', 'editScopeChanged'],
    ['OPERATING_CURRENCY_BRANCH_MISMATCH', 'editScopeChanged'],
    ['EDIT_LOCAL_STORAGE_BUSY', 'editStorageBusy'],
    ['EDIT_LOCAL_STORAGE_LOCKED', 'editStorageBusy'],
    ['EDIT_LOCAL_STORAGE_CONSTRAINT', 'editStorageConstraint'],
    ['EDIT_LOCAL_STORAGE_IO', 'editStorageIo'],
    ['EDIT_LOCAL_STORAGE_OTHER', 'editLocalOperationFailed'],
    ['PAYMENT_ORDER_NOT_FOUND', 'editOrderNotFound'],
    ['PAYMENT_GHOST_ORDER', 'editGhostOrder'],
    ['PAYMENT_COLLECTOR_NOT_DRAWER_OWNER', 'editCollectorNotDrawerOwner'],
    ['PAYMENT_INVALID_REQUEST', 'editInvalidDetails'],
    ['REFUND_INVALID_REQUEST', 'editInvalidDetails'],
    ['PAYMENT_DRIVER_EARNING_REQUIRED', 'editDriverSettlementUnavailable'],
    ['REFUND_DRIVER_EARNING_REQUIRED', 'editDriverSettlementUnavailable'],
    ['REFUND_PAYMENT_NOT_FOUND', 'editOriginalPaymentUnavailable'],
    ['REFUND_PAYMENT_VOIDED', 'editRefundOriginalUnavailable'],
    ['REFUND_PAYMENT_SET_ASIDE', 'editRefundOriginalUnavailable'],
    ['REFUND_IDEMPOTENCY_CONFLICT', 'editRefundIdentityConflict'],
    ['REFUND_AMOUNT_EXCEEDS_BALANCE', 'editRefundBalanceChanged'],
    ['EDIT_INVALID_DELIVERY_COORDINATES', 'editInvalidDetails'],
    ['EDIT_INVALID_ORDER_TYPE', 'editInvalidDetails'],
    ['MANUAL_CANCEL_UNAVAILABLE', 'editCancellationUnavailable'],
    ['MANUAL_CANCEL_PROVIDER_CONNECTED', 'editOriginalProviderRequired'],
    ['MANUAL_CANCEL_ORIGINAL_PROVIDER_REQUIRED', 'editOriginalProviderRequired'],
    ['EDIT_SETTLEMENT_RECONCILIATION_REQUIRED', 'editReconciliationRequired'],
    ['EDIT_SETTLEMENT_BUSY', 'editSettlementBusy'],
  ])('%s gives a reason and next step', (code, key) => {
    expect(editRefusalMessageKey(code)).toBe(key);
    for (const locale of [en, el, de, fr, itLocale, sq]) {
      const message = locale.modals.menu[key as keyof typeof locale.modals.menu];
      expect(typeof message).toBe('string');
      expect(String(message).length).toBeGreaterThan(60);
      expect(message).not.toMatch(/\?{2}|\uFFFD/);
    }
  });
  it('keeps unknown failure guidance actionable in every language', () => {
    expect(editRefusalMessageKey('UNKNOWN_CODE')).toBe('editFailed');
    for (const locale of [en, el, de, fr, itLocale, sq]) {
      expect(locale.modals.menu.editFailed.length).toBeGreaterThan(100);
    }
  });
});
