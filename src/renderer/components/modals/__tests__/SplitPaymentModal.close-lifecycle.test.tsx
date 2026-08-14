import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const getOrderPayments = vi.fn();
  const getPaidItems = vi.fn();
  const getOrderById = vi.fn();

  return {
    getOrderPayments,
    getPaidItems,
    getOrderById,
    askForPaymentPrint: vi.fn().mockResolvedValue(false),
    bridge: {
      payments: {
        getOrderPayments,
        getPaidItems,
        printSplitReceipt: vi.fn(),
        printReceipt: vi.fn(),
        recordPayment: vi.fn(),
      },
      orders: {
        getById: getOrderById,
        updateFinancials: vi.fn(),
      },
      settings: { get: vi.fn().mockResolvedValue(false) },
      ecr: {
        fiscalPrint: vi.fn(),
        getDefaultTerminal: vi.fn(),
        getDeviceStatus: vi.fn(),
        processPayment: vi.fn(),
      },
    },
  };
});

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    t: (_key: string, fallback?: string) => fallback ?? 'Close',
  }),
}));

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

vi.mock('../../../../lib', () => ({
  getBridge: () => mocks.bridge,
  emitCompatEvent: vi.fn(),
}));

vi.mock('../../../hooks/usePaymentPrintPrompt', () => ({
  usePaymentPrintPrompt: () => ({
    askForPaymentPrint: mocks.askForPaymentPrint,
    paymentPrintPromptModal: null,
  }),
}));

import { LiquidGlassModal } from '../../ui/pos-glass-components';
import { SplitPaymentModal } from '../SplitPaymentModal';

describe('split-payment close lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrderPayments.mockResolvedValue([]);
    mocks.getPaidItems.mockResolvedValue([]);
    mocks.getOrderById.mockResolvedValue({
      total_amount: 20,
      subtotal: 20,
      discount_amount: 0,
      tax_amount: 0,
      delivery_fee: 0,
      tip_amount: 0,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('request-close mode leaves the dialog mounted until its parent closes it', async () => {
    const onClose = vi.fn();
    const view = render(
      <LiquidGlassModal
        isOpen
        onClose={onClose}
        title="Split Payment"
        closeMode="request"
      >
        <p>Payment content</p>
      </LiquidGlassModal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Split Payment' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog).toBeInTheDocument();
    expect(dialog).not.toHaveClass('leaving');

    view.rerender(
      <LiquidGlassModal
        isOpen={false}
        onClose={onClose}
        title="Split Payment"
        closeMode="request"
      >
        <p>Payment content</p>
      </LiquidGlassModal>,
    );
    await waitFor(() => expect(dialog).toHaveClass('leaving'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeDisabled blocks request-close from the X, Escape, and backdrop', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onClose = vi.fn();
    render(
      <LiquidGlassModal
        isOpen
        onClose={onClose}
        title="Split Payment"
        closeMode="request"
        closeDisabled
        closeOnBackdrop
        closeOnEscape
      >
        <p>Payment content</p>
      </LiquidGlassModal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Split Payment' });
    const closeButton = screen.getByRole('button', { name: 'Close' });
    const backdrop = document.querySelector('.liquid-glass-modal-backdrop');

    expect(closeButton).toBeDisabled();
    expect(closeButton).toHaveAttribute('aria-disabled', 'true');
    expect(backdrop).not.toBeNull();

    fireEvent.click(closeButton);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(backdrop!);

    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
    expect(dialog).not.toHaveClass('leaving');
  });

  it('keeps the real split dialog mounted for reconciliation and locks every close path while pending', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onClose = vi.fn();
    const props = {
      isOpen: true,
      onClose,
      orderId: 'order-1',
      orderTotal: 20,
      items: [{ name: 'Coffee', quantity: 1, totalPrice: 20 }],
      onSplitComplete: vi.fn(),
    };
    const view = render(<SplitPaymentModal {...props} />);

    await waitFor(() => expect(mocks.getOrderById).toHaveBeenCalledWith('order-1'));
    const dialog = screen.getByRole('dialog', { name: 'Split Payment' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog).toBeInTheDocument();
    expect(dialog).not.toHaveClass('leaving');

    view.rerender(<SplitPaymentModal {...props} isReconciliationPending />);
    const closeButton = screen.getByRole('button', { name: 'Close' });
    const backdrop = document.querySelector('.liquid-glass-modal-backdrop');

    expect(closeButton).toBeDisabled();
    expect(closeButton).toHaveAttribute('aria-disabled', 'true');
    expect(backdrop).not.toBeNull();

    fireEvent.click(closeButton);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(backdrop!);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog).toBeInTheDocument();
    expect(dialog).not.toHaveClass('leaving');
  });
});
