// Salon follow-ups (founder, 21/10/2026): a tip can go to a stylist of the
// order. The `staff` recipient appears only when the order's lines name a
// stylist; with one stylist it is preselected, with several the cashier picks;
// the amount keeps cents digit entry; the stylist reaches the payment payload.
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  t: (key: string, fallback?: string | { defaultValue?: string }) =>
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: h.t, i18n: { language: 'en' } }),
}));
vi.mock('react-hot-toast', () => ({ default: h.toast }));
vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: (key: string) => (key === 'common.actions.close' ? 'Close' : key) }),
}));
vi.mock('../../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isFeatureEnabled: () => true, isMobileWaiter: false, loading: false }),
}));
vi.mock('../../../hooks/useAcquiredModules', async (original) => ({
  ...(await original<typeof import('../../../hooks/useAcquiredModules')>()),
  useAcquiredModules: () => ({ hasModule: (id: string) => id !== 'plugin_integrations' }),
}));

import { TipModal, tipStaffOptionsFromItems } from '../TipModal';
import { PaymentModal } from '../PaymentModal';
import { setStoreCurrencyFromSettings } from '../../../utils/store-currency';

const MARIA = { staffId: '5a1f0000-0000-4000-8000-000000000001', staffName: 'Maria' };
const ELENI = { staffId: '5a1f0000-0000-4000-8000-000000000002', staffName: 'Eleni' };

const amountField = () => screen.getByRole('textbox', { name: 'Or enter an amount' });
const staffRole = () => screen.queryByRole('button', { name: /Staff member/ });
const applyButton = () => screen.getByRole('button', { name: /Apply Tip/ });

afterEach(cleanup);

describe('tip staff options from the order lines', () => {
  it('lists each stylist of the lines once, with the line name', () => {
    expect(tipStaffOptionsFromItems([
      { name: 'Haircut', staff_id: MARIA.staffId, metadata: { staff_id: MARIA.staffId, staff_name: 'Maria' } },
      { name: 'Colour', staff_id: ELENI.staffId, metadata: { staff_name: 'Eleni' } },
      { name: 'Blow dry', staffId: MARIA.staffId },
      { name: 'Shampoo', menu_item_id: 'shampoo' },
      { name: 'Walk-in', staff_id: null, metadata: { staff_id: null, staff_name: null } },
    ])).toEqual([MARIA, ELENI]);
    expect(tipStaffOptionsFromItems([{ staff_id: 'no-name' }])).toEqual([{ staffId: 'no-name', staffName: 'no-name' }]);
    expect(tipStaffOptionsFromItems(undefined)).toEqual([]);
  });
});

describe('TipModal staff recipient', () => {
  it('offers no staff recipient when the order has no stylist (restaurant checkout unchanged)', () => {
    const onApply = vi.fn();
    render(<TipModal isOpen onClose={vi.fn()} baseAmount={20} orderType="dine-in" selection={null} onApply={onApply} />);
    expect(staffRole()).toBeNull();
    expect(screen.getByRole('button', { name: /Waiter/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(amountField(), { target: { value: '150' } });
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledWith({ amount: 1.5, recipientRole: 'waiter' });
  });

  it('preselects the only stylist and takes the amount as cents digits', () => {
    const onApply = vi.fn();
    render(<TipModal isOpen onClose={vi.fn()} baseAmount={50} orderType="pickup" selection={null} onApply={onApply}
      staffOptions={[MARIA]} />);
    expect(staffRole()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Maria' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Cashier/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.change(amountField(), { target: { value: '500' } });
    expect(amountField()).toHaveValue('5,00');
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledWith({
      amount: 5, recipientRole: 'staff', recipientStaffId: MARIA.staffId, recipientStaffName: 'Maria',
    });
  });

  it('makes the cashier pick one of several stylists before applying', () => {
    const onApply = vi.fn();
    render(<TipModal isOpen onClose={vi.fn()} baseAmount={50} orderType="pickup" selection={null} onApply={onApply}
      staffOptions={[MARIA, ELENI]} />);
    fireEvent.change(amountField(), { target: { value: '350' } });
    expect(screen.getByRole('button', { name: 'Maria' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Eleni' })).toHaveAttribute('aria-pressed', 'false');
    expect(applyButton()).toBeDisabled();
    fireEvent.click(applyButton());
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Eleni' }));
    expect(applyButton()).toBeEnabled();
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledWith({
      amount: 3.5, recipientRole: 'staff', recipientStaffId: ELENI.staffId, recipientStaffName: 'Eleni',
    });
  });

  it('still lets the cashier give the tip to the cashier instead', () => {
    const onApply = vi.fn();
    render(<TipModal isOpen onClose={vi.fn()} baseAmount={50} orderType="pickup" selection={null} onApply={onApply}
      staffOptions={[MARIA]} />);
    fireEvent.click(screen.getByRole('button', { name: /Cashier/ }));
    expect(screen.queryByTestId('tip-staff-choices')).toBeNull();
    fireEvent.change(amountField(), { target: { value: '100' } });
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledWith({ amount: 1, recipientRole: 'cashier' });
  });

  it('restores an applied stylist when the modal opens again', () => {
    render(<TipModal isOpen onClose={vi.fn()} baseAmount={50} orderType="pickup" onApply={vi.fn()}
      selection={{ amount: 2, recipientRole: 'staff', recipientStaffId: ELENI.staffId, recipientStaffName: 'Eleni' }}
      staffOptions={[MARIA, ELENI]} />);
    expect(amountField()).toHaveValue('2,00');
    expect(screen.getByRole('button', { name: 'Eleni' })).toHaveAttribute('aria-pressed', 'true');
    expect(applyButton()).toBeEnabled();
  });
});

describe('PaymentModal carries the stylist to the payment', () => {
  beforeEach(() => setStoreCurrencyFromSettings({
    'terminal.branch_id': 'branch-1', 'restaurant.store_currency_branch_id': 'branch-1',
    'restaurant.store_currency_available': true, 'restaurant.store_currency_source': 'branch_country',
    'restaurant.currency': 'EUR',
  }));

  it('sends tipRecipientRole staff with the stylist id on a cash payment', async () => {
    const onPaymentComplete = vi.fn().mockResolvedValue(true);
    render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={50} orderType="pickup"
      onPaymentComplete={onPaymentComplete} tipStaffOptions={[MARIA, ELENI]} />);
    fireEvent.click(screen.getByRole('button', { name: /Add tip/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Or enter an amount' }), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Maria' }));
    fireEvent.click(applyButton());
    await waitFor(() => expect(screen.getByRole('button', { name: /Edit tip/ })).toHaveTextContent('Maria'));
    fireEvent.click(screen.getByRole('button', { name: /CASH/ }));
    const complete = screen.getByRole('button', { name: 'Complete' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Cash Received' }), { target: { value: '55,00' } });
    fireEvent.click(complete);
    await waitFor(() => expect(onPaymentComplete).toHaveBeenCalledTimes(1));
    expect(onPaymentComplete).toHaveBeenCalledWith(expect.objectContaining({
      method: 'cash', amount: 55, tipAmount: 5, tipRecipientRole: 'staff', tipRecipientStaffId: MARIA.staffId,
    }));
  });
});
