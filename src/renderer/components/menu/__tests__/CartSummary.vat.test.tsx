import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CartSummary } from '../CartSummary';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'percent' in options ? `${key}(${options.percent})` : key,
  }),
}));
vi.mock('../../../../lib/i18n', () => ({ default: { language: 'en' } }));
// `general.tax_rate` (the old cart rate) is 24 here: it must change nothing.
vi.mock('../../../hooks/useDiscountSettings', () => ({
  useDiscountSettings: () => ({ maxDiscountPercentage: 50, taxRatePercentage: 24, isLoading: false }),
}));

afterEach(() => cleanup());

const renderCart = (ownerVatRatePercent: number | null | undefined, orderType: 'pickup' | 'delivery' = 'pickup') =>
  render(
    <CartSummary
      cartItems={[{ id: 'crepe', name: 'Crepe', price: 6.5, quantity: 2 }]}
      orderType={orderType}
      deliveryFee={orderType === 'delivery' ? 1.8 : 0}
      customerInfo={{ name: 'A', phone: '123', address: 'Street' }}
      onEditCustomer={vi.fn()}
      onUpdateQuantity={vi.fn()}
      onRemoveItem={vi.fn()}
      onPlaceOrder={vi.fn()}
      ownerVatRatePercent={ownerVatRatePercent}
    />,
  );

const rowValue = (container: HTMLElement, label: string): string => {
  const rows = Array.from(container.querySelectorAll('div.flex.justify-between'));
  const row = rows.find((element) => element.textContent?.startsWith(label));
  return row?.lastElementChild?.textContent ?? '';
};

describe('CartSummary VAT preview (founder rule 07/10/2026)', () => {
  it("keeps Tomikro's preview: owner rate 0, a 0% row and the same total", () => {
    const { container } = renderCart(0);
    expect(container.textContent).toContain('menu.cart.tax(0)');
    expect(rowValue(container, 'menu.cart.tax(0)')).toMatch(/0[.,]00/);
    expect(rowValue(container, 'menu.cart.total')).toMatch(/13[.,]00/);
  });

  it('shows no VAT for a store without a rate, whatever general.tax_rate says', () => {
    const { container } = renderCart(null);
    expect(container.textContent).toContain('menu.cart.tax(0)');
    expect(rowValue(container, 'menu.cart.tax(0)')).toMatch(/0[.,]00/);
    expect(rowValue(container, 'menu.cart.total')).toMatch(/13[.,]00/);
  });

  it('shows the owner VAT inside the total and never adds it', () => {
    const { container } = renderCart(24, 'delivery');
    // 13.00 + 1.80 delivery = 14.80; 1480 * 24 / 124 = 286.45 -> 2.86.
    expect(rowValue(container, 'menu.cart.tax(24)')).toMatch(/2[.,]86/);
    expect(rowValue(container, 'menu.cart.total')).toMatch(/14[.,]80/);
  });
});
