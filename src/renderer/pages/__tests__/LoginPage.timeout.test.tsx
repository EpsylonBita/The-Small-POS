import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  app: {
    getVersion: vi.fn().mockResolvedValue({ version: 'test' }),
  },
  auth: {
    setupPin: vi.fn().mockResolvedValue({ success: true }),
  },
  settings: {
    getLocal: vi.fn().mockResolvedValue({
      'staff.admin_pin_hash': 'configured',
      'terminal.legacy_pin_migrated': true,
    }),
    updateLocal: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../../lib', () => ({
  getBridge: () => bridge,
  offEvent: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('../../contexts/i18n-context', () => ({
  useI18n: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    t: (key: string, fallback?: string) => {
      const copy: Record<string, string> = {
        'login.title': 'The Small',
        'login.subtitle': 'Enter your PIN to continue',
        'login.clear': 'Clear',
        'login.backspace': 'Backspace',
        'login.loggingIn': 'Logging in…',
        'login.loginButton': 'Login',
        'login.errors.invalidPin': 'Wrong code',
        'login.errors.loginFailed': 'Login failed. Please try again.',
        'login.errors.timeout': 'Login took too long. Please try again.',
        'login.createPin': 'Create PIN',
        'login.newPin': 'New PIN (6 digits)',
        'login.confirmPin': 'Confirm PIN',
        'login.savePin': 'Save PIN',
        'common.cancel': 'Cancel',
      };
      return copy[key] ?? fallback ?? key;
    },
  }),
}));

vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('../../components/AnimatedBackground', () => ({
  default: () => null,
}));

vi.mock('../../components/ThemeToggle', () => ({
  default: () => null,
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, variants: _variants, initial: _initial, animate: _animate, ...props }: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>) => (
      <div {...props}>{children}</div>
    ),
    button: ({ children, variants: _variants, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => (
      <button {...props}>{children}</button>
    ),
  },
}));

import LoginPage from '../LoginPage';

async function enterSixDigitPin(): Promise<void> {
  for (const digit of ['1', '2', '3', '4', '5', '6']) {
    fireEvent.click(screen.getByRole('button', { name: digit }));
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

describe('LoginPage login deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridge.settings.getLocal.mockResolvedValue({
      'staff.admin_pin_hash': 'configured',
      'terminal.legacy_pin_migrated': true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps waiting for a valid native login that takes longer than eight seconds', async () => {
    const onLogin = vi.fn(() => new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 9_000);
    }));

    render(<LoginPage onLogin={onLogin} />);
    await enterSixDigitPin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_001);
    });

    expect(screen.queryByText('Wrong code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logging in…' })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.queryByText('Wrong code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Login' })).toBeEnabled();
  });

  it('shows a timeout message instead of reporting a wrong PIN', async () => {
    const onLogin = vi.fn().mockRejectedValue(
      new Error('auth.login timed out after 30000ms'),
    );

    render(<LoginPage onLogin={onLogin} />);
    await enterSixDigitPin();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Login took too long. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('Wrong code')).not.toBeInTheDocument();
  });

  it('enforces one six-digit PIN rule and keeps the setup actions readable', async () => {
    bridge.settings.getLocal.mockResolvedValue({
      'terminal.legacy_pin_migrated': true,
    });

    render(<LoginPage onLogin={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create PIN' }));

    const newPin = screen.getByLabelText('New PIN (6 digits)');
    fireEvent.change(newPin, { target: { value: '1234567' } });

    expect(newPin).toHaveValue('123456');

    const saveButton = screen.getByRole('button', { name: 'Save PIN' });
    expect(saveButton).toHaveClass(
      'whitespace-nowrap',
      'text-green-700',
      'dark:text-green-200',
    );

    const lockIcon = document.querySelector('.lucide-lock');
    expect(lockIcon).not.toBeNull();
    expect(lockIcon).toHaveClass('text-yellow-600', 'dark:text-yellow-300');
    expect(lockIcon?.parentElement).not.toHaveClass('rounded-full', 'bg-yellow-500/10');
  });
});
