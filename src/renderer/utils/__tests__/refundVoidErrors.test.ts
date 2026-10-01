import { describe, expect, it } from 'vitest';

import { refundVoidErrorMessage } from '../refundVoidErrors';

// Item D3, round 2 review (01/10/2026): a 1.4.119 placeholder payment row
// records no money, so the till refuses to refund or void it
// (PAYMENT_PLACEHOLDER_NOT_MONEY). The refund screen says so in the
// operator's language instead of the till's raw English.

const t = (key: string, options?: Record<string, unknown>) =>
  typeof options?.defaultValue === 'string' ? `[${key}] ${options.defaultValue}` : key;

describe('refundVoidErrorMessage', () => {
  it('explains a placeholder row in the operator language, as a string or an error', () => {
    const raw =
      "PAYMENT_PLACEHOLDER_NOT_MONEY: this payment row records no money (the till guessed it from the order's label).";
    for (const error of [raw, new Error(raw)]) {
      expect(refundVoidErrorMessage(error, t, 'Refund failed')).toMatch(
        /^\[modals\.refund\.placeholderNotMoney\] This payment row records no money/,
      );
    }
  });

  it("keeps the till's own message, or the fallback", () => {
    expect(refundVoidErrorMessage('Cannot refund a voided payment', t, 'Refund failed')).toBe(
      'Cannot refund a voided payment',
    );
    expect(refundVoidErrorMessage(undefined, t, 'Void failed')).toBe('Void failed');
  });
});
