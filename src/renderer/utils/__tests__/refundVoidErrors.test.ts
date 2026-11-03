import { describe, expect, it } from 'vitest';

import { refundVoidErrorMessage } from '../refundVoidErrors';
import en from '../../../locales/en.json';
import el from '../../../locales/el.json';
import de from '../../../locales/de.json';
import fr from '../../../locales/fr.json';
import itLocale from '../../../locales/it.json';
import sq from '../../../locales/sq.json';

// Item D3, round 2 review (01/10/2026): a 1.4.119 placeholder payment row
// records no money, so the till refuses to refund or void it
// (PAYMENT_PLACEHOLDER_NOT_MONEY). The refund screen says so in the
// operator's language instead of the till's raw English.

const t = (key: string, options?: Record<string, unknown>) =>
  typeof options?.defaultValue === 'string' ? `[${key}] ${options.defaultValue}` : key;

describe('refundVoidErrorMessage', () => {
  it('localizes canonical refresh and final-return refusals without exposing technical details', () => {
    expect(refundVoidErrorMessage('PAYMENT_CANONICAL_REFRESH_REQUIRED: HTTP 503', t, 'Refund failed')).toBe('modals.refund.canonicalRefreshRequired');
    expect(refundVoidErrorMessage('PAYMENT_CANONICAL_RETURN_FINAL: already returned', t, 'Refund failed')).toBe('modals.refund.canonicalReturnFinal');
  });
  it('explains a placeholder row in the operator language, as a string or an error', () => {
    const raw =
      "PAYMENT_PLACEHOLDER_NOT_MONEY: this payment row records no money (the till guessed it from the order's label).";
    for (const error of [raw, new Error(raw)]) {
      expect(refundVoidErrorMessage(error, t, 'Refund failed')).toMatch(
        /^\[modals\.refund\.placeholderNotMoney\] This payment row records no money/,
      );
    }
  });

  it.each([
    ['REFUND_PAYMENT_VOIDED', 'paymentVoided'],
    ['REFUND_PAYMENT_SET_ASIDE', 'paymentSetAside'],
    ['REFUND_AMOUNT_EXCEEDS_BALANCE', 'amountExceedsBalance'],
    ['REFUND_PAYMENT_NOT_FOUND', 'paymentNotFound'],
    ['REFUND_INVALID_REQUEST', 'invalidRequest'],
    ['REFUND_IDEMPOTENCY_CONFLICT', 'idempotencyConflict'],
    ['REFUND_DRIVER_EARNING_REQUIRED', 'driverEarningRequired'],
  ])('explains %s as an ordinary refund refusal in every language', (code, key) => {
    expect(refundVoidErrorMessage(code, t, 'Refund failed')).toBe(`modals.refund.refusals.${key}`);
    for (const locale of [en, el, de, fr, itLocale, sq]) {
      const translate = (path: string) => path.split('.').reduce<any>((value, part) => value?.[part], locale);
      const message = translate(`modals.refund.refusals.${key}`);
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(50);
      expect(message).not.toMatch(/\?{2}|\uFFFD|PRIVATE_CANARY|REFUND_/);
      expect(refundVoidErrorMessage(new Error(`${code}: PRIVATE_CANARY`), translate, 'Refund failed')).toBe(message);
    }
  });

  it("keeps an unrelated till message, or the fallback", () => {
    expect(refundVoidErrorMessage('A different refusal', t, 'Refund failed')).toBe('A different refusal');
    expect(refundVoidErrorMessage(undefined, t, 'Void failed')).toBe('Void failed');
  });
});
