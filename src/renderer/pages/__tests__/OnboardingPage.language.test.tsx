import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setLanguage: vi.fn(), toastError: vi.fn() }));
vi.mock('../../contexts/i18n-context', () => ({
  useI18n: () => ({
    language: 'en',
    setLanguage: mocks.setLanguage,
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
vi.mock('../../../lib', () => ({ getBridge: () => ({}) }));
vi.mock('../../components/recovery/RecoveryPanel', () => ({ default: () => null }));
vi.mock('react-hot-toast', () => ({ Toaster: () => null, toast: { error: mocks.toastError, success: vi.fn() } }));

import OnboardingPage from '../OnboardingPage';

beforeEach(() => {
  mocks.setLanguage.mockReset();
  mocks.toastError.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

it('waits for language persistence before advancing to terminal connection', async () => {
  let resolve!: () => void;
  mocks.setLanguage.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
  render(<OnboardingPage />);
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(screen.getByRole('heading', { name: 'Select Language' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'English' })).toBeDisabled();
  await act(async () => { resolve(); });
  expect(screen.queryByRole('heading', { name: 'Select Language' })).not.toBeInTheDocument();
  expect(mocks.toastError).not.toHaveBeenCalled();
});

it('stays on language selection and reports a failed save', async () => {
  let reject!: (error: Error) => void;
  mocks.setLanguage.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail; }));
  render(<OnboardingPage />);
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(screen.getByRole('button', { name: 'English' })).toBeDisabled();
  // Await the rejected save and React's resulting commit, not the toast side effect.
  await act(async () => { reject(new Error('native save failed')); });
  expect(mocks.toastError).toHaveBeenCalledWith('Failed to save changes.');
  expect(screen.getByRole('heading', { name: 'Select Language' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'English' })).not.toBeDisabled();
});

it('lays the six language cards out in equal-sized pairs — the last card never stretches across the row', () => {
  render(<OnboardingPage />);
  const names = ['English', 'Ελληνικά', 'Deutsch', 'Français', 'Italiano', 'Shqip'];
  const cards = names.map((name) => screen.getByRole('button', { name }));
  expect(cards).toHaveLength(6);
  for (const card of cards) expect(card.className).not.toContain('col-span-2');
  // Every card carries the same layout classes, so none renders wider than its neighbours.
  const layout = (el: HTMLElement) => el.className.split(/\s+/).filter((c) => !/^(border-|bg-|text-|active:)/.test(c)).sort().join(' ');
  for (const card of cards) expect(layout(card)).toBe(layout(cards[0]));
});
