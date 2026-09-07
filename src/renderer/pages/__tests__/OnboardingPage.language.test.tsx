import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  mocks.setLanguage.mockRejectedValue(new Error('native save failed'));
  render(<OnboardingPage />);
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Failed to save changes.'));
  expect(screen.getByRole('heading', { name: 'Select Language' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'English' })).not.toBeDisabled();
});
