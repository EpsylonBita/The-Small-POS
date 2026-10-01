import { describe, expect, it, vi } from 'vitest';

// Founder rule 30/09 and 01/10/2026: the till refuses to cancel an order
// labelled paid whose payment is not recorded here
// (`ORDER_PAYMENT_NOT_RECORDED`), before the PIN. The table release question
// and the table check tell the cashier to restore the record from the server
// or record the payment, instead of "The order could not be cancelled".

vi.mock('../../../lib', () => ({ getBridge: () => ({}) }));

import { owingCancelFailureMessage } from '../useTableReleaseGuard';

const t = (key: string, options?: Record<string, unknown>) =>
  typeof options?.defaultValue === 'string' ? options.defaultValue : key;

describe('owingCancelFailureMessage', () => {
  it('explains a paid label with no payment record', () => {
    expect(
      owingCancelFailureMessage(
        'ORDER_PAYMENT_NOT_RECORDED: this order is marked paid, but its payment is not recorded on this till.',
        t,
      ),
    ).toBe(
      'This order is marked paid, but its payment is not recorded on this till. Restore it from the server with Sync Now, or record the payment from the Z Report, then cancel.',
    );
  });

  it('keeps the money-taken message', () => {
    expect(owingCancelFailureMessage(new Error('ORDER_HAS_PAYMENTS: money was taken'), t)).toBe(
      'Money was taken on this order. Void or refund it from the order first, or collect the rest.',
    );
  });
});
