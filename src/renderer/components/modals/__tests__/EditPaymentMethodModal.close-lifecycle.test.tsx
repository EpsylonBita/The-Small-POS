import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
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

import { EditPaymentMethodModal } from '../EditPaymentMethodModal';

describe('EditPaymentMethodModal close lifecycle', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('blocks every close path while saving and lets the header close normally afterward', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onClose = vi.fn();
    const props = {
      isOpen: true,
      onClose,
      currentMethod: 'cash' as const,
      payments: [{ id: 'payment-1', method: 'cash' as const, amount: 18.5 }],
      onSave: vi.fn(),
    };
    const view = render(<EditPaymentMethodModal {...props} isSaving />);

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

    view.rerender(<EditPaymentMethodModal {...props} isSaving={false} />);
    await waitFor(() => expect(closeButton).toBeEnabled());

    fireEvent.click(closeButton);
    await waitFor(() => expect(dialog).toHaveClass('leaving'));
    expect(document.querySelector('.liquid-glass-modal-backdrop')).toHaveClass('leaving');
  });
});
