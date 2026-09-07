import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../theme-context';
import ThemeToggle from '../../components/ThemeToggle';
import { ThemeSwitcher } from '../../components/ThemeSwitcher';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('../i18n-context', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-hot-toast', () => ({ toast: { error: toastError } }));

let api: ReturnType<typeof useTheme>;
function Consumer() {
  api = useTheme();
  return <output data-testid="theme">{api.theme}/{api.resolvedTheme}</output>;
}

beforeEach(() => {
  localStorage.clear();
  toastError.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 7, 12));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const root of [document.documentElement, document.body]) {
    root.classList.remove('dark');
    root.removeAttribute('data-theme');
  }
});

it('hydrates the saved theme without overwriting it and persists later choices before displaying them', () => {
  localStorage.setItem('pos-theme', 'light');
  const write = vi.spyOn(Storage.prototype, 'setItem');
  render(<React.StrictMode><ThemeProvider><Consumer /></ThemeProvider></React.StrictMode>);
  expect(write).not.toHaveBeenCalled();
  expect(screen.getByTestId('theme')).toHaveTextContent('light/light');
  expect(document.documentElement).not.toHaveClass('dark');

  act(() => api.setTheme('dark'));
  expect(localStorage.getItem('pos-theme')).toBe('dark');
  expect(screen.getByTestId('theme')).toHaveTextContent('dark/dark');
  expect(document.documentElement).toHaveClass('dark');
  expect(document.body).toHaveClass('dark');
});

it('survives blocked startup storage and reports failed saves without changing state or CSS', () => {
  localStorage.setItem('pos-theme', 'light');
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('read blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
  render(<ThemeProvider><Consumer /><ThemeToggle /><ThemeSwitcher /></ThemeProvider>);
  expect(screen.getByTestId('theme')).toHaveTextContent('auto/light');
  expect(() => api.setTheme('dark')).toThrow('quota exceeded');
  fireEvent.click(screen.getByRole('button', { name: 'app.themeToggle.title' }));
  fireEvent.click(screen.getByTitle('theme.switchToDark'));
  expect(toastError).toHaveBeenCalledTimes(2);
  expect(toastError).toHaveBeenCalledWith('errors.saveFailed');
  expect(screen.getByTestId('theme')).toHaveTextContent('auto/light');
  expect(document.documentElement).not.toHaveClass('dark');
  read.mockRestore();
  expect(localStorage.getItem('pos-theme')).toBe('light');
});
