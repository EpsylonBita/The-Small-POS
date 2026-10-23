import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
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

const renderCart = (
  slipsPrintVat: boolean,
  orderType: 'pickup' | 'delivery' = 'pickup',
  vatSettings: Record<string, unknown> | null = null,
) =>
  render(
    <CartSummary
      cartItems={[{ id: 'crepe', name: 'Crepe', price: 6.5, quantity: 2, menuItemId: 'crepe' }]}
      orderType={orderType}
      deliveryFee={orderType === 'delivery' ? 1.8 : 0}
      customerInfo={{ name: 'A', phone: '123', address: 'Street' }}
      onEditCustomer={vi.fn()}
      onUpdateQuantity={vi.fn()}
      onRemoveItem={vi.fn()}
      onPlaceOrder={vi.fn()}
      vatSettings={vatSettings}
      slipsPrintVat={slipsPrintVat}
    />,
  );

const rowValue = (container: HTMLElement, label: string): string => {
  const rows = Array.from(container.querySelectorAll('div.flex.justify-between'));
  const row = rows.find((element) => element.textContent?.startsWith(label));
  return row?.lastElementChild?.textContent ?? '';
};

describe('CartSummary VAT preview (founder rule 21/10/2026: one VAT per order)', () => {
  it('taxes a food class by the order channel while keeping the same inclusive total', () => {
    const props = {cartItems:[{id:'food',name:'Food',price:10.26,quantity:1,vatClass:'food'}],customerInfo:{name:'A',phone:'123',address:'Street'},
      onEditCustomer:vi.fn(),onUpdateQuantity:vi.fn(),onRemoveItem:vi.fn(),onPlaceOrder:vi.fn(),slipsPrintVat:true,
      vatSettings:{country:'CH',classCategoryCodes:{food:{dine_in:'ch_standard_81',takeaway:'ch_reduced_26'}}}};
    const {container,rerender} = render(<CartSummary {...props} orderType="pickup" />);
    expect(rowValue(container,'modals.orderDetails.tax')).toMatch(/0[.,]26/);
    expect(rowValue(container,'menu.cart.total')).toMatch(/10[.,]26/);
    rerender(<CartSummary {...props} orderType="dine-in" />);
    expect(rowValue(container,'modals.orderDetails.tax')).toMatch(/0[.,]77/);
    expect(rowValue(container,'menu.cart.total')).toMatch(/10[.,]26/);
  });

  it("shows no VAT row while the slip prints none (Tomikro's switch off), and the same total", () => {
    const { container } = renderCart(false, 'delivery');
    expect(container.textContent).not.toContain('modals.orderDetails.tax');
    expect(rowValue(container, 'menu.cart.total')).toMatch(/14[.,]80/);
  });

  it('shows the computed VAT inside the total, the delivery fee at 13 %, never added', () => {
    const { container } = renderCart(true, 'delivery');
    // 13.00 at 24 % = 2.52, 1.80 at 13 % = 0.21: 2.73, not 24 % of 14.80 (2.86).
    expect(rowValue(container, 'modals.orderDetails.tax')).toMatch(/2[.,]73/);
    expect(rowValue(container, 'menu.cart.total')).toMatch(/14[.,]80/);
  });

  it('keeps unit prices, mixed categories and the submitted discount identical to native inputs', () => {
    const place = vi.fn();
    const { container, getByLabelText, getByRole } = render(<CartSummary
      cartItems={[
        { id: 'a', name: 'Reduced', quantity: 2, price: 999, unitPrice: 6.5, totalPrice: 13,
          vatCategoryCode: 'gr_reduced_13' },
        { id: 'b', name: 'Standard', quantity: 1, price: 6.5, vatCategoryCode: 'gr_standard_24' },
      ]}
      orderType="pickup" customerInfo={{ name: 'A', phone: '123', address: '' }}
      onEditCustomer={vi.fn()} onUpdateQuantity={vi.fn()} onRemoveItem={vi.fn()}
      onPlaceOrder={place} slipsPrintVat
    />);
    expect(rowValue(container, 'menu.cart.subtotal')).toMatch(/19[.,]50/);
    expect(rowValue(container, 'modals.orderDetails.tax')).toMatch(/2[.,]76/);
    fireEvent.change(getByLabelText('menu.cart.discountLabel'), { target: { value: '10' } });
    // 1.30 allocated to reduced goods and 0.65 to standard goods: VAT 1.35 + 1.13.
    expect(rowValue(container, 'modals.orderDetails.tax')).toMatch(/2[.,]48/);
    expect(rowValue(container, 'menu.cart.total')).toMatch(/17[.,]55/);
    fireEvent.click(getByRole('button', { name: 'menu.summary.placeOrder' }));
    expect(place).toHaveBeenCalledWith(1.95);
  });

  it('uses the branch VAT profile: Swiss reduced rate, and nothing when not VAT-registered', () => {
    const swiss = renderCart(true, 'pickup', { country: 'CH', defaultVatCategoryCode: 'ch_reduced_26' });
    // 13.00 at 2.6 %: 1300 - round(1300 / 1.026) = 33 cents.
    expect(rowValue(swiss.container, 'modals.orderDetails.tax')).toMatch(/0[.,]33/);
    cleanup();
    const unregistered = renderCart(true, 'pickup', { vatRegistered: false });
    expect(unregistered.container.textContent).not.toContain('modals.orderDetails.tax');
    expect(rowValue(unregistered.container, 'menu.cart.total')).toMatch(/13[.,]00/);
  });
});
