import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discountCents, fromCents, roundMoney, toCents } from '../money';

/**
 * The Windows POS half of the money contract (module audit, final high-risk closure
 * 2026-09-16).
 *
 * `shared/types/money-fixtures.json` is the specification: every euro amount with the exact
 * integer cents the platform must produce. The admin server, the Android POS and the Rust
 * core each read the same file. A cent of drift between them fails here instead of on a
 * customer's receipt.
 */
type Fixtures = {
  rule: string;
  toCents: Array<{ amount: number; cents: number; why: string }>;
  couponDiscount: Array<{ subtotalCents: number; type: string; value: number; discountCents: number; why: string }>;
  orderTotals: Array<{
    name: string;
    lines: Array<{ unitPrice: number; quantity: number }>;
    coupon: { type: string; value: number } | null;
    manualDiscount: { type: string; value: number } | null;
    deliveryFee: number;
    vatRatePercent: number;
    expected: {
      subtotalCents: number;
      manualDiscountCents: number;
      couponDiscountCents: number;
      discountCents: number;
      feesCents: number;
      totalCents: number;
      taxCents: number;
    };
  }>;
};

/** Walk up from the vitest root until the repository's shared folder appears. */
function resolveFixturePath(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(directory, 'shared', 'types', 'money-fixtures.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`money-fixtures.json not found above ${process.cwd()}`);
}

const fixtures: Fixtures = JSON.parse(readFileSync(resolveFixturePath(), 'utf8'));

describe('money (Windows POS) follows the cross-platform fixtures', () => {
  it('reads the specification it is measured against', () => {
    expect(fixtures.rule).toBe('round half away from zero at two decimal places');
    expect(fixtures.toCents.length).toBeGreaterThanOrEqual(20);
  });

  it.each(fixtures.toCents.map((c) => [c.amount, c.cents, c.why] as const))(
    'toCents(%p) is %p (%s)',
    (amount, cents) => {
      expect(toCents(amount)).toBe(cents);
      expect(Object.is(toCents(amount), -0)).toBe(false);
      expect(roundMoney(amount)).toBe(fromCents(cents));
    }
  );

  it.each(
    fixtures.couponDiscount.map((c) => [c.subtotalCents, c.type, c.value, c.discountCents, c.why] as const)
  )('a %p cent subtotal with a %s discount of %p gives %p cents (%s)', (subtotalCents, type, value, expected) => {
    expect(discountCents(type, value, subtotalCents)).toBe(expected);
  });

  describe('order totals', () => {
    for (const order of fixtures.orderTotals) {
      it(order.name, () => {
        const subtotalCents = order.lines.reduce(
          (sum, line) => sum + toCents(line.unitPrice * line.quantity),
          0
        );
        const manualDiscountCents = order.manualDiscount
          ? discountCents(order.manualDiscount.type, order.manualDiscount.value, subtotalCents)
          : 0;
        const couponDiscountCents = order.coupon
          ? discountCents(order.coupon.type, order.coupon.value, subtotalCents - manualDiscountCents)
          : 0;
        const totalDiscountCents = manualDiscountCents + couponDiscountCents;
        const feesCents = toCents(order.deliveryFee);
        const totalCents = subtotalCents - totalDiscountCents + feesCents;
        const taxableCents = Math.max(0, subtotalCents - totalDiscountCents);
        const taxCents = taxableCents - Math.round(taxableCents / (1 + order.vatRatePercent / 100));

        expect({
          subtotalCents,
          manualDiscountCents,
          couponDiscountCents,
          discountCents: totalDiscountCents,
          feesCents,
          totalCents,
          taxCents,
        }).toEqual(order.expected);
        expect(subtotalCents - totalDiscountCents + feesCents).toBe(totalCents);
      });
    }
  });

  it('is the rule the old local helpers got wrong', () => {
    // Three copies of roundMoney did Math.round(value * 100) / 100 and one did
    // Number(value.toFixed(2)); both send 1.005 to 1.00.
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(Math.round(1.005 * 100) / 100).toBe(1);
    expect(Number((1.005).toFixed(2))).toBe(1);
  });
});
