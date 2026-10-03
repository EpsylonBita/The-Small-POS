/**
 * supplier-invoice-automation task 8.2 (review fix) — the till's half of the
 * two office-written payment labels.
 *
 * Spec: `.claude/specs/supplier-invoice-automation`; design §4.5, §4.13;
 * requirements R11.3, R11.7, R16.3.
 *
 * Why this file exists at all: the shipped proof of these labels was a source
 * regex over `SuppliersPage.tsx` (`tests/renderer/suppliers-page-ui.test.ts`),
 * which asserts the branch is written — not that it can ever be taken. What is
 * pinned here instead is the **answer** the till gives for rows shaped exactly
 * as `GET /api/pos/supplier-invoices` sends them, so a label that cannot be
 * reached cannot pass for a label that works.
 *
 * The row shapes below are the ones
 * `admin-dashboard/src/app/api/pos/supplier-invoices/__tests__/route.test.ts`
 * sends: a payment the supplier's own statement implied (`payment_method =
 * 'unknown'`, M3) and the contra row that undid one (a negative amount, M4).
 * That route names no `origin`: the column arrives with M4, production has not
 * taken it, and one missing name fails the whole select — which is why the sign
 * is the signal that must answer on its own, and is pinned doing so below.
 */

import { describe, expect, it } from 'vitest';

import { getPaymentLabelKey } from '../SuppliersPage';

/** A payment row as `GET /api/pos/supplier-invoices` returns one. */
function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payment-1',
    amount: 185.41,
    payment_date: '2026-09-03',
    payment_method: 'cash',
    ...overrides,
  } as Parameters<typeof getPaymentLabelKey>[0];
}

describe('the two office-written payment rows are labelled in words', () => {
  it('labels the contra row a reversal from the word the office stores, when it has it', () => {
    expect(
      getPaymentLabelKey(
        paymentRow({ amount: -185.41, payment_method: 'unknown', origin: 'reversal' })
      )
    ).toBe('suppliers.payment.reversal');
  });

  it('labels it a reversal from the sign alone, as the route sends it today', () => {
    // `GET /api/pos/supplier-invoices` does not select `origin` — the column is
    // M4's and production has not taken it — so this is the shape that really
    // arrives. A negative amount is what a contra row is: nothing else may be
    // negative, and the mobile till reads exactly this.
    expect(getPaymentLabelKey(paymentRow({ amount: -185.41, payment_method: 'unknown' }))).toBe(
      'suppliers.payment.reversal'
    );
  });

  it('says the method was never stated when the statement implied the payment', () => {
    expect(
      getPaymentLabelKey(paymentRow({ payment_method: 'unknown', origin: 'statement' }))
    ).toBe('suppliers.paymentMethod.unknown');
  });

  it('leaves a payment a person made at this till labelled by its method', () => {
    expect(getPaymentLabelKey(paymentRow({ payment_method: 'cash', origin: 'manual' }))).toBe(
      'suppliers.invoices.methods.cash'
    );
    expect(getPaymentLabelKey(paymentRow({ payment_method: 'bank_transfer' }))).toBe(
      'suppliers.invoices.methods.bankTransfer'
    );
    expect(getPaymentLabelKey(paymentRow({ payment_method: 'credit_card' }))).toBe(
      'suppliers.invoices.methods.creditCard'
    );
  });

  it('never answers with the reversal label for an ordinary positive payment', () => {
    expect(getPaymentLabelKey(paymentRow({ amount: 0, payment_method: 'other' }))).toBe(
      'suppliers.invoices.methods.other'
    );
    expect(getPaymentLabelKey(paymentRow({ amount: '185.41', payment_method: 'check' }))).toBe(
      'suppliers.invoices.methods.check'
    );
  });
});
