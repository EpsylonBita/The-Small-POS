import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CartSummary } from '../CartSummary';
import { setStoreCurrencyFromSettings } from '../../../utils/store-currency';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../lib/i18n', () => ({ default: { language: 'el-GR' } }));
vi.mock('../../../hooks/useDiscountSettings', () => ({ useDiscountSettings: () => ({ maxDiscountPercentage: 50, taxRatePercentage: 24, isLoading: false }) }));
afterEach(() => { cleanup(); setStoreCurrencyFromSettings({}); });
it('shows Swiss catalog, customization, delivery and totals in CHF even in Greek', () => {
  setStoreCurrencyFromSettings({ terminal: { branch_id: 'ch' }, restaurant: {
    currency: 'CHF', store_currency_available: true, store_currency_source: 'branch_country', store_currency_branch_id: 'ch',
  } });
  const { container } = render(<CartSummary cartItems={[{
    id: 'coffee', name: 'Coffee', price: 5, quantity: 1,
    customizations: [{ customizationId: 'milk', optionId: 'oat', name: 'Oat milk', price: 1 }],
  }]} orderType="delivery" deliveryFee={2} customerInfo={{ name: 'A', phone: '123', address: 'Street' }}
    onEditCustomer={vi.fn()} onUpdateQuantity={vi.fn()} onRemoveItem={vi.fn()} onPlaceOrder={vi.fn()} />);
  expect(container.textContent).toContain('CHF');
  expect(container.textContent).not.toContain('€');
  expect(container.textContent?.match(/CHF/g)?.length).toBeGreaterThanOrEqual(5);
});
