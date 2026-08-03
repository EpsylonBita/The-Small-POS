import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib', () => ({
  getBridge: () => ({
    settings: {
      updateTerminalCredentials: vi.fn(),
    },
    terminalConfig: {
      syncFromAdmin: vi.fn(),
    },
  }),
}));

vi.mock('../../contexts/i18n-context', () => ({
  useI18n: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

vi.mock('../../components/recovery/RecoveryPanel', () => ({
  default: () => <div>Local Recovery</div>,
}));

vi.mock('react-hot-toast', () => ({
  Toaster: () => null,
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, variants: _variants, initial: _initial, animate: _animate, ...props }: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>) => (
      <div {...props}>{children}</div>
    ),
    h2: ({ children, variants: _variants, ...props }: React.HTMLAttributes<HTMLHeadingElement> & Record<string, unknown>) => (
      <h2 {...props}>{children}</h2>
    ),
    button: ({ children, variants: _variants, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => (
      <button {...props}>{children}</button>
    ),
    form: ({ children, variants: _variants, initial: _initial, animate: _animate, ...props }: React.FormHTMLAttributes<HTMLFormElement> & Record<string, unknown>) => (
      <form {...props}>{children}</form>
    ),
  },
}));

import OnboardingPage from '../OnboardingPage';

describe('OnboardingPage theme scope', () => {
  it('keeps the Local Recovery panel inside the page dark-theme scope', () => {
    render(<OnboardingPage />);

    const recovery = screen.getByText('Local Recovery');
    const onboardingRoot = recovery.closest('.modern-scrollbar');

    expect(onboardingRoot).toHaveClass('dark');
  });
});
