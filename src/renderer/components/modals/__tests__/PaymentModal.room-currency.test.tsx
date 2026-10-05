import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: string | { defaultValue?: string }) => (
        typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
      ),
    }),
  };
});

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    t: (key: string) => key === 'common.actions.close' ? 'Close' : key,
  }),
}));

vi.mock('../../../hooks/useFeatures', () => ({
  useFeatures: () => ({
    isFeatureEnabled: () => true,
    isMobileWaiter: false,
    loading: false,
  }),
}));

vi.mock('../../../hooks/useAcquiredModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useAcquiredModules')>();
  return {
    ...actual,
    useAcquiredModules: () => ({ hasModule: (id: string) => id !== 'plugin_integrations' }),
  };
});

import { PaymentModal } from '../PaymentModal';


import { setStoreCurrencyFromSettings } from '../../../utils/store-currency';
const notices = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), {success:vi.fn(),error:vi.fn()}) }));
vi.mock('react-hot-toast', () => ({ default: notices.toast }));
const room = {roomId:'room-1',activeFolioId:'folio-1',currency:'CHF'};
beforeEach(() => setStoreCurrencyFromSettings({'terminal.branch_id':'branch-1','restaurant.store_currency_branch_id':'branch-1','restaurant.store_currency_available':true,'restaurant.store_currency_source':'branch_country','restaurant.currency':'CHF'}));
afterEach(cleanup);
describe('room payment confirmation and immutable currency', () => {
  it('does not claim a folio charge succeeded when only the local order was saved', async () => {
    const onPaymentComplete = vi.fn().mockResolvedValue(true);
    render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={3} allowTips={false} roomChargeContext={room} onPaymentComplete={onPaymentComplete} />);
    fireEvent.click(screen.getByRole('button',{name:/ROOM/}));
    await waitFor(() => expect(onPaymentComplete).toHaveBeenCalledTimes(1));
    expect(onPaymentComplete).toHaveBeenCalledWith(expect.objectContaining({method:'room_charge',currency:'CHF'}));
    expect(notices.toast).toHaveBeenCalledWith('guestBilling.roomChargePending');
    expect(notices.toast.success).not.toHaveBeenCalled();
  });
  it('shows success only on an explicit server-applied proof', async () => {
    const onPaymentComplete = vi.fn(async payment => {payment.roomChargeApplied=true;return true;});
    render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={3} allowTips={false} roomChargeContext={room} onPaymentComplete={onPaymentComplete} />);
    fireEvent.click(screen.getByRole('button',{name:/ROOM/}));
    await waitFor(() => expect(notices.toast.success).toHaveBeenCalledWith('Charged to room'));
  });
  it.each([null,'EUR'])('does not admit a new charge into a %s folio under CHF', currency => {
    const onPaymentComplete=vi.fn();
    render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={3} allowTips={false} roomChargeContext={{...room,currency}} onPaymentComplete={onPaymentComplete} />);
    expect(screen.queryByRole('button',{name:/ROOM/})).toBeNull();
    expect(onPaymentComplete).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
