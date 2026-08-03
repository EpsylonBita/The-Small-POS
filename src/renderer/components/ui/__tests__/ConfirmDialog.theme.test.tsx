import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, children, ariaLabel }: { isOpen: boolean; children: React.ReactNode; ariaLabel: string }) => (
    isOpen ? <div role="dialog" aria-label={ariaLabel}>{children}</div> : null
  ),
  POSGlassButton: ({ children, variant, loading: _loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; loading?: boolean }) => (
    <button data-variant={variant} {...props}>{children}</button>
  ),
  POSGlassInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { ConfirmDialog } from '../ConfirmDialog';

describe('ConfirmDialog theme-aware destructive states', () => {
  it('uses the modal text palette for warning details in light and dark themes', () => {
    const { container } = render(
      <ConfirmDialog
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Factory Reset Warning"
        message="This will restore the terminal."
        variant="warning"
        details={<ul><li>All settings will be cleared</li></ul>}
      />,
    );

    const details = screen.getByText('All settings will be cleared').closest('div');
    expect(details).toHaveClass('liquid-glass-modal-text-muted');
    expect(details).not.toHaveClass('liquid-glass-modal-inset');

    const icon = container.querySelector('.lucide-triangle-alert');
    expect(icon).not.toBeNull();
    expect(icon?.parentElement).not.toHaveClass('rounded-full', 'bg-yellow-400/18', 'p-3');
  });

  it('uses readable red details and a matching red checkbox for an error confirmation', () => {
    render(
      <ConfirmDialog
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Final Confirmation"
        message="This is your last chance to cancel."
        variant="error"
        requireCheckbox="I understand"
        details={<div>All data will be permanently deleted</div>}
      />,
    );

    const details = screen.getByText('All data will be permanently deleted').closest('div')?.parentElement;
    expect(details).toHaveClass('text-red-700', 'dark:text-red-300');
    expect(details).not.toHaveClass('liquid-glass-modal-inset');

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toHaveClass('text-red-600', 'focus:ring-red-500/70');
  });
});
