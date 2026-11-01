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
    t: (key: string, fallback?: string | { minutes: number }) => {
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
        'login.errors.lockedOut': 'Too many wrong PIN attempts. Try again in {{minutes}} minutes.',
        'login.createPin': 'Create PIN',
        'common.retry': 'Retry',
        'login.newPin': 'New PIN (6 digits)',
        'login.confirmPin': 'Confirm PIN',
        'login.savePin': 'Save PIN',
        'common.cancel': 'Cancel',
      };
      const text = copy[key] ?? (typeof fallback === 'string' ? fallback : key);
      return typeof fallback === 'object' ? text.replace('{{minutes}}', String(fallback.minutes)) : text;
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
    img: ({ variants: _variants, initial: _initial, animate: _animate, onAnimationComplete: _done, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & Record<string, unknown>) => (
      <img {...props} />
    ),
    span: ({ children, variants: _variants, initial: _initial, animate: _animate, ...props }: React.HTMLAttributes<HTMLSpanElement> & Record<string, unknown>) => (
      <span {...props}>{children}</span>
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
    // No sign-in button (founder 31/10): the check shows in the live region and the keypad rests.
    expect(screen.getByText('Logging in…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1' })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.queryByText('Wrong code')).not.toBeInTheDocument();
    expect(screen.queryByText('Logging in…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Login' })).not.toBeInTheDocument();
  });

  it('shows a timeout message instead of reporting a wrong PIN, and «Retry» sends the PIN again', async () => {
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

    await act(async () => {
      fireEvent.click(screen.getByTestId('login-retry'));
      await Promise.resolve();
    });
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(onLogin).toHaveBeenLastCalledWith('123456');
  });

  it.each([
    { code: 'AUTH_LOCKED_OUT', minutes: 15, reason: 'Too many failed attempts' },
    JSON.stringify({ code: 'AUTH_LOCKED_OUT', minutes: 15, reason: 'Too many failed attempts' }),
    new Error(JSON.stringify({ code: 'AUTH_LOCKED_OUT', minutes: 15, reason: 'Too many failed attempts' })),
  ])('shows the remaining lockout minutes from the native error: %j', async error => {
    render(<LoginPage onLogin={vi.fn().mockRejectedValue(error)} />);
    await enterSixDigitPin();
    expect(screen.getByText('Too many wrong PIN attempts. Try again in 15 minutes.')).toBeInTheDocument();
    expect(screen.queryByText('Login failed. Please try again.')).not.toBeInTheDocument();
    // The keypad rests until the lockout ends, and the minutes count down.
    expect(screen.getByRole('button', { name: '1' })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(screen.getByText('Too many wrong PIN attempts. Try again in 10 minutes.')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(screen.queryByText(/Too many wrong PIN attempts/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1' })).toBeEnabled();
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
    // Wave ΣΤ7: «Save PIN» is the kit glass-modal primary (yellow in both themes, readable label).
    expect(saveButton).toHaveClass('whitespace-nowrap', 'liquid-glass-modal-button', 'pos-modal-primary');

    const lockIcon = document.querySelector('.lucide-lock');
    expect(lockIcon).not.toBeNull();
    expect(lockIcon).toHaveClass('text-yellow-600', 'dark:text-yellow-300');
    expect(lockIcon?.parentElement).not.toHaveClass('rounded-full', 'bg-yellow-500/10');
  });
});

// Founder 31/10 («με το που βάλεις το σωστό PIN κάνει login μόνο του ... μήπως έβγαζα τελείως το κουμπί»):
// no sign-in button; the screen signs in by itself at the PIN's known length, a shorter PIN gets a small
// enter key, and no PIN is ever sent on a guess (a wrong attempt counts towards the lockout).
describe('LoginPage without a sign-in button', () => {
  const press = (digits: string) => {
    for (const digit of digits) fireEvent.click(screen.getByRole('button', { name: digit }));
  };
  const filledDots = () => screen.getByTestId('login-pin-dots').querySelectorAll('.bg-current').length;
  const renderWith = async (settings: Record<string, unknown>, onLogin = vi.fn().mockResolvedValue(true)) => {
    bridge.settings.getLocal.mockResolvedValue({ 'terminal.legacy_pin_migrated': true, ...settings });
    render(<LoginPage onLogin={onLogin} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return onLogin;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('has no sign-in button and signs in by itself at six digits', async () => {
    const onLogin = await renderWith({ 'staff.admin_pin_hash': 'h', 'staff.staff_pin_hash': 'h' });
    expect(screen.queryByRole('button', { name: 'Login' })).not.toBeInTheDocument();
    expect(screen.getByTestId('login-pin-dots').children).toHaveLength(6);

    press('12345');
    expect(onLogin).not.toHaveBeenCalled();
    expect(screen.queryByTestId('login-enter-key')).not.toBeInTheDocument();
    press('6');
    await act(async () => {
      await Promise.resolve();
    });
    expect(onLogin).toHaveBeenCalledWith('123456');
  });

  it('a wrong PIN empties the field, keeps the message and shakes the field', async () => {
    await renderWith({ 'staff.admin_pin_hash': 'h' }, vi.fn().mockResolvedValue(false));
    press('123456');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Wrong code')).toBeInTheDocument();
    expect(filledDots()).toBe(0);
    expect(screen.getByTestId('login-pin-field')).toHaveClass('pos-login-shake');
  });

  it('signs in by itself at four when every PIN the till knows has four digits', async () => {
    const onLogin = await renderWith({
      'staff.admin_pin_hash': 'h',
      'staff.staff_pin_hash': 'h',
      'terminal.login_pin_length_admin': 4,
      'terminal.login_pin_length_staff': 4,
    });
    expect(screen.getByTestId('login-pin-dots').children).toHaveLength(4);
    press('1234');
    await act(async () => {
      await Promise.resolve();
    });
    expect(onLogin).toHaveBeenCalledWith('1234');
  });

  it('a four-digit staff PIN beside a six-digit admin PIN gets the enter key at once, never a guess', async () => {
    const onLogin = await renderWith({
      'staff.admin_pin_hash': 'h',
      'staff.staff_pin_hash': 'h',
      'terminal.login_pin_length_admin': 6,
      'terminal.login_pin_length_staff': 4,
    });
    press('1234');
    await act(async () => {
      await Promise.resolve();
    });
    expect(onLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('login-enter-key'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onLogin).toHaveBeenCalledWith('1234');
  });

  it('leaving after an accepted PIN rests the keypad and reports when the logo is in the middle', async () => {
    // jsdom has no layout, so the logo cannot fly: the screen reports at once instead of holding the till.
    bridge.settings.getLocal.mockResolvedValue({ 'terminal.legacy_pin_migrated': true, 'staff.admin_pin_hash': 'h' });
    const onLeft = vi.fn();
    render(<LoginPage onLogin={vi.fn()} exitPhase="leaving" onLeft={onLeft} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onLeft).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '1' })).toBeDisabled();
    expect(screen.getByTestId('login-card')).toHaveClass('pointer-events-none');
  });

  it('a shorter PIN the till does not know gets the enter key after a pause', async () => {
    const onLogin = await renderWith({ 'staff.admin_pin_hash': 'h', 'staff.staff_pin_hash': 'h' });
    press('1234');
    expect(screen.queryByTestId('login-enter-key')).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(onLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('login-enter-key'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onLogin).toHaveBeenCalledWith('1234');
  });
});
