import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateCredentials: vi.fn(), sync: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn(),
}));
vi.mock('../../../lib', () => ({ getBridge: () => ({
  settings: { updateTerminalCredentials: mocks.updateCredentials },
  terminalConfig: { syncFromAdmin: mocks.sync },
}) }));
vi.mock('../../contexts/i18n-context', () => ({ useI18n: () => ({
  language: 'en', setLanguage: vi.fn().mockResolvedValue(undefined),
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}) }));
vi.mock('../../components/recovery/RecoveryPanel', () => ({ default: () => null }));
vi.mock('react-hot-toast', () => ({
  Toaster: () => null, toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import OnboardingPage from '../OnboardingPage';

beforeEach(() => {
  mocks.updateCredentials.mockReset().mockResolvedValue({ success: true });
  mocks.sync.mockReset().mockResolvedValue({ success: true });
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(cleanup);

const validCode = btoa(JSON.stringify({ key: 'fixture-api-key', url: 'https://admin.example/api/', tid: 'TEST-TERMINAL' }));

async function openConnection(value = validCode) {
  render(<OnboardingPage />);
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value } });
  return input;
}

async function submitConnection() {
  const input = await openConnection();
  fireEvent.click(screen.getByRole('button', { name: 'Connect & Sync' }));
  return input;
}

it.each(['credentials', 'sync'])('shows the native string rejection from %s without marking setup complete', async (stage) => {
  const message = 'Terminal not configured: missing terminal_id';
  (stage === 'credentials' ? mocks.updateCredentials : mocks.sync).mockRejectedValue(message);
  await submitConnection();
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(message));
  expect(screen.getByText(message)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect & Sync' })).toBeEnabled();
  expect(localStorage.getItem('pos-terminal-configured')).toBeNull();
  if (stage === 'credentials') expect(mocks.sync).not.toHaveBeenCalled();
});

it('keeps a readable fallback when the native rejection has no message', async () => {
  mocks.updateCredentials.mockRejectedValue(null);
  await submitConnection();
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('An unexpected error occurred'));
  expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect & Sync' })).toBeEnabled();
});

it('previews the terminal and normalized server before sending any credentials', async () => {
  const input = await openConnection();
  expect(screen.getByRole('heading', { name: 'Connect your terminal' })).toHaveFocus();
  expect(screen.getByLabelText('Connection code')).toBe(input);
  expect(input).toHaveAttribute('aria-invalid', 'false');
  const preview = screen.getByRole('complementary', { name: 'Review your connection' });
  expect(within(preview).getByText('TEST-TERMINAL')).toBeInTheDocument();
  expect(within(preview).getByText('https://admin.example')).toBeInTheDocument();
  expect(preview.textContent).not.toContain('fixture-api-key');
  expect(mocks.updateCredentials).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
});

it.each([
  ['not-a-code', 'This connection code is incomplete or invalid.'],
  ['a'.repeat(48), 'This looks like an API key.'],
  [btoa(JSON.stringify({ key: 'fixture', url: 'https://admin.example', tid: 123 })), 'This connection code is incomplete or invalid.'],
])('explains invalid input without a preview or native request', async (value, message) => {
  const input = await openConnection(value);
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('status')).toHaveTextContent(message);
  expect(screen.queryByText('Code ready')).not.toBeInTheDocument();
  fireEvent.submit(input.closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('alert')).toHaveFocus();
  expect(mocks.updateCredentials).not.toHaveBeenCalled();
});

it.each([
  { success: false, error: 'Terminal access revoked' },
  { success: true, data: { success: false, error: 'Terminal access revoked' } },
  undefined,
  {},
])('requires confirmed settings sync before marking the terminal configured', async (result) => {
  mocks.sync.mockResolvedValue(result);
  await submitConnection();
  await screen.findByRole('alert');
  expect(localStorage.getItem('pos-terminal-configured')).toBeNull();
  expect(localStorage.getItem('admin_dashboard_url')).toBeNull();
  expect(mocks.toastSuccess).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Connect & Sync' })).toBeEnabled();
});

it('shows checking and sync progress, rejects duplicate form submissions, then completes', async () => {
  let resolveCredentials!: (value: unknown) => void;
  let resolveSync!: (value: unknown) => void;
  mocks.updateCredentials.mockImplementation(() => new Promise((resolve) => { resolveCredentials = resolve; }));
  mocks.sync.mockImplementation(() => new Promise((resolve) => { resolveSync = resolve; }));
  const input = await submitConnection();
  const form = input.closest('form')!;
  expect(screen.getByRole('status')).toHaveTextContent('Checking connection…');
  expect(input).toBeDisabled();
  fireEvent.submit(form);
  expect(mocks.updateCredentials).toHaveBeenCalledTimes(1);
  expect(mocks.sync).not.toHaveBeenCalled();

  await act(async () => { resolveCredentials({ success: true }); });
  expect(screen.getByRole('status')).toHaveTextContent('Syncing terminal settings…');
  expect(localStorage.getItem('pos-terminal-configured')).toBeNull();
  fireEvent.submit(form);
  expect(mocks.updateCredentials).toHaveBeenCalledTimes(1);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  await act(async () => { resolveSync({ success: true }); });
  expect(screen.getByRole('heading', { name: 'Your terminal is ready' })).toBeInTheDocument();
  expect(localStorage.getItem('pos-terminal-configured')).toBe('1');
  expect(localStorage.getItem('admin_dashboard_url')).toBe('https://admin.example');
  expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  expect(mocks.updateCredentials).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'TEST-TERMINAL', adminDashboardUrl: 'https://admin.example' }));
});

it('keeps the code after sync failure and permits a successful retry', async () => {
  mocks.sync.mockRejectedValueOnce('Network is unavailable').mockResolvedValueOnce({ success: true });
  const input = await submitConnection();
  expect(await screen.findByRole('alert')).toHaveTextContent('Network is unavailable');
  expect(input).toHaveValue(validCode);
  fireEvent.click(screen.getByRole('button', { name: 'Connect & Sync' }));
  await screen.findByRole('heading', { name: 'Your terminal is ready' });
  expect(mocks.updateCredentials).toHaveBeenCalledTimes(2);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem('pos-terminal-configured')).toBe('1');
});

it('clears a stale error when input changes and preserves input when returning from language selection', async () => {
  mocks.updateCredentials.mockRejectedValue('Connection failed');
  const input = await submitConnection();
  await screen.findByRole('alert');
  fireEvent.change(input, { target: { value: `${validCode} ` } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(await screen.findByLabelText('Connection code')).toHaveValue(`${validCode} `);
});
