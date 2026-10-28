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
    ['SHIFT_CURRENCY_UNAVAILABLE', 'editCurrencyUnavailable'],
    ['PAYMENT_CURRENCY_UNAVAILABLE', 'editCurrencyUnavailable'],
    ['ORDER_CURRENCY_MISMATCH', 'editCurrencyMismatch'],
    ['PAYMENT_COLLECTOR_STAFF_MISMATCH', 'editCollectorUnavailable'],
    ['CASHIER_REQUIRED', 'editCollectorUnavailable'],
    ['EDIT_COLLECTION_AMOUNT_MISMATCH', 'editPaymentMismatch'],
    ['EDIT_LOCAL_OPERATION_FAILED', 'editLocalOperationFailed'],
    ['EDIT_SETTLEMENT_OUTCOME_UNKNOWN', 'editLocalOperationFailed'],
    ['CHECKOUT_DRAFT_SCOPE_CHANGED', 'editScopeChanged'],
    ['OPERATING_CURRENCY_BRANCH_MISMATCH', 'editScopeChanged'],
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
