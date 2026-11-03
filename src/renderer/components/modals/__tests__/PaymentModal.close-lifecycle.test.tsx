import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import toast from 'react-hot-toast';

const support = vi.hoisted(() => ({ ipc: vi.fn().mockResolvedValue({}) }));
vi.mock('../../../../lib/ipc-adapter', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../lib/ipc-adapter')>(), supportIpc: support.ipc,
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
    useAcquiredModules: () => ({ hasModule: () => false }),
  };
});

import { PaymentModal } from '../PaymentModal';

describe('PaymentModal close lifecycle', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens support fencing before payment input and retains it until the parent save settles', async () => {
    support.ipc.mockClear();
    let finish: () => void = () => {};
    const onPaymentComplete = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={18.5} onPaymentComplete={onPaymentComplete} allowTips={false} />);
    const token = support.ipc.mock.calls[0][1].token;
    expect(support.ipc).toHaveBeenCalledWith('support_payment_open', { token });
    fireEvent.click(screen.getByRole('button', { name: /Cash/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '20,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(onPaymentComplete).toHaveBeenCalledOnce());
    expect(support.ipc).not.toHaveBeenCalledWith('support_payment_closed', { token });
    await act(async () => { finish(); });
    await waitFor(() => expect(support.ipc).toHaveBeenCalledWith('support_payment_closed', { token }));
    view.unmount();
    const opens = support.ipc.mock.calls.filter(([command]) => command === 'support_payment_open');
    for (const [, payload] of opens) { expect(support.ipc).toHaveBeenCalledWith('support_payment_closed', payload); }
  });

  it.each([
    ['PAYMENT_INVALID_REQUEST', 'modals.payment.refusals.invalidRequest'],
    ['EDIT_LOCAL_STORAGE_IO', 'modals.payment.refusals.storageIo'],
  ])('explains %s without changing payment submission', async (code, message) => {
    const showError = vi.spyOn(toast, 'error').mockReturnValue('payment-refusal');
    const onPaymentComplete = vi.fn().mockRejectedValue(new Error(code));
    render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={18.5}
      onPaymentComplete={onPaymentComplete} allowTips={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Cash/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '20,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(showError).toHaveBeenCalledWith(message));
    expect(onPaymentComplete).toHaveBeenCalledOnce();
    expect(onPaymentComplete).toHaveBeenCalledWith(expect.objectContaining({
      method: 'cash', amount: 18.5, cashReceived: 20, change: 1.5,
    }));
  });

  it('keeps cash completion outside scrolling content and submits the entered amount once', async () => {
    const onPaymentComplete = vi.fn().mockResolvedValue(undefined);
    render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={18.5}
      onPaymentComplete={onPaymentComplete} allowTips={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Cash/ }));
    const complete = screen.getByRole('button', { name: 'Complete' });
    expect(complete.closest('.liquid-glass-modal-content')).toBeNull();
    expect(complete).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '20,00' } });
    expect(complete).toBeEnabled();
    fireEvent.click(complete);
    await waitFor(() => expect(onPaymentComplete).toHaveBeenCalledTimes(1));
    expect(onPaymentComplete).toHaveBeenCalledWith(expect.objectContaining({
      method: 'cash', amount: 18.5, cashReceived: 20, change: 1.5,
    }));
  });

  it('blocks every close path while processing and lets the header close normally afterward', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onClose = vi.fn();
    const props = {
      isOpen: true,
      onClose,
      orderTotal: 18.5,
      onPaymentComplete: vi.fn(),
      allowTips: false,
    };
    const view = render(<PaymentModal {...props} isProcessing />);

    const dialog = screen.getByRole('dialog');
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

    view.rerender(<PaymentModal {...props} isProcessing={false} />);
    await waitFor(() => expect(closeButton).toBeEnabled());

    fireEvent.click(closeButton);
    await waitFor(() => expect(dialog).toHaveClass('leaving'));
    expect(document.querySelector('.liquid-glass-modal-backdrop')).toHaveClass('leaving');
  });
});
