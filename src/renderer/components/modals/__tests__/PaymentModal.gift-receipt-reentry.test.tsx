import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tender = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

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
    useAcquiredModules: () => ({ hasModule: (id: string) => id === actual.MODULE_IDS.GIFT_CARDS }),
  };
});

// The Tender's own recovery, readiness and receipt actions are covered by its
// suite; here only what the modal hands the order's own Tender matters.
vi.mock('../../payment/GiftCardTender', () => ({
  GiftCardTender: (props: Record<string, unknown>) => {
    tender.props.push(props);
    return <section data-testid="gift-card-tender" />;
  },
}));

import { PaymentModal, type PaymentModalExistingOrder } from '../PaymentModal';

const onGiftEvent = vi.fn();
const paidOrder = (overrides: Partial<PaymentModalExistingOrder> = {}): PaymentModalExistingOrder => ({
  orderId: 'order-gift-paid',
  orderSynced: true,
  currency: 'EUR',
  scope: { organizationId: 'org-1', terminalId: 'term-1' },
  online: true,
  outstandingCents: 0,
  giftEnabled: true,
  giftReceiptRecovery: true,
  onGiftEvent,
  ...overrides,
});

describe('PaymentModal gift receipt reentry', () => {
  afterEach(() => {
    cleanup();
    tender.props.length = 0;
    vi.clearAllMocks();
  });

  it('reopens a gift-paid order straight on its own Tender with no way to collect money', async () => {
    const onClose = vi.fn();
    const onPaymentComplete = vi.fn();
    const props = {
      onClose,
      orderTotal: 0,
      onPaymentComplete,
      allowTips: false,
      existingOrder: paidOrder(),
    };
    const view = render(<PaymentModal isOpen {...props} />);

    expect(screen.getByTestId('gift-card-tender')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /CASH/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /CARD/ })).toBeNull();
    expect(tender.props.at(-1)).toMatchObject({
      orderId: 'order-gift-paid',
      fixedAmountCents: 0,
      onEvent: onGiftEvent,
    });

    // A later reopen of the same reentry lands on the Tender again.
    view.rerender(<PaymentModal isOpen={false} {...props} />);
    view.rerender(<PaymentModal isOpen {...props} />);
    expect(screen.getByTestId('gift-card-tender')).toBeInTheDocument();

    // Back has no payment selection to return to: it closes the reentry.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: /CASH/ })).toBeNull();
    expect(onPaymentComplete).not.toHaveBeenCalled();
  });

  it('never opens the gift step for a zero balance without the host reentry', () => {
    render(
      <PaymentModal
        isOpen
        onClose={vi.fn()}
        orderTotal={0}
        onPaymentComplete={vi.fn()}
        allowTips={false}
        existingOrder={paidOrder({ giftReceiptRecovery: false })}
      />,
    );

    expect(screen.queryByTestId('gift-card-tender')).toBeNull();
    expect(screen.getByRole('button', { name: /CASH/ })).toBeInTheDocument();
    expect(tender.props).toHaveLength(0);
  });
});
