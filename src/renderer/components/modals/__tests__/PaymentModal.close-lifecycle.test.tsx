import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('keeps cash completion outside scrolling content and submits the entered amount once', async () => {
    const onPaymentComplete = vi.fn().mockResolvedValue(undefined);
    render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={18.5}
      onPaymentComplete={onPaymentComplete} allowTips={false} />);
    fireEvent.click(screen.getByRole('button', { name: /CASH/ }));
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
