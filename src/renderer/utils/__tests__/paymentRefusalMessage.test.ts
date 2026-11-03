import { describe, expect, it } from 'vitest';
import { paymentRefusalMessage } from '../paymentRefusalMessage';
import en from '../../../locales/en.json';
import el from '../../../locales/el.json';
import de from '../../../locales/de.json';
import fr from '../../../locales/fr.json';
import itLocale from '../../../locales/it.json';
import sq from '../../../locales/sq.json';

const cases = [
  ['PAYMENT_INVALID_REQUEST', 'invalidRequest'],
  ['PAYMENT_ORDER_NOT_FOUND', 'orderNotFound'],
  ['PAYMENT_GHOST_ORDER', 'ghostOrder'],
  ['PAYMENT_COLLECTOR_SHIFT_REQUIRED', 'collectorShiftRequired'],
  ['PAYMENT_COLLECTOR_NOT_DRAWER_OWNER', 'collectorNotDrawerOwner'],
  ['PAYMENT_DRIVER_EARNING_REQUIRED', 'driverEarningRequired'],
  ['EDIT_LOCAL_STORAGE_BUSY', 'storageBusy'],
  ['EDIT_LOCAL_STORAGE_LOCKED', 'storageBusy'],
  ['EDIT_LOCAL_STORAGE_CONSTRAINT', 'storageConstraint'],
  ['EDIT_LOCAL_STORAGE_IO', 'storageIo'],
  ['EDIT_LOCAL_STORAGE_OTHER', 'storageOther'],
];

describe('ordinary payment refusal guidance', () => {
  it.each(cases)('translates %s without edit wording or private detail', (code, key) => {
    for (const locale of [en, el, de, fr, itLocale, sq]) {
      const t = (path: string) => path.split('.').reduce<any>((value, part) => value?.[part], locale);
      const message = t(`modals.payment.refusals.${key}`);
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(50);
      expect(message).not.toMatch(/\?{2}|\uFFFD|PRIVATE_CANARY|[A-Z]+_[A-Z_]+/);
      for (const error of [code, new Error(`${code}: PRIVATE_CANARY`), { message: code }]) {
        expect(paymentRefusalMessage(error, t)).toBe(message);
      }
    }
    expect(paymentRefusalMessage(code, path => path)).toBe(`modals.payment.refusals.${key}`);
  });

  it('preserves existing fallback behavior for unrelated errors and code suffixes', () => {
    for (const error of [undefined, null, {}, 'Declined by bank', 'PAYMENT_INVALID_REQUEST_EXTRA', 'MY_PAYMENT_GHOST_ORDER']) {
      expect(paymentRefusalMessage(error, path => path)).toBeNull();
    }
  });
});
