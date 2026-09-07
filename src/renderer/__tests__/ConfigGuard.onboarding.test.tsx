import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  return {
    listeners,
    bridge: {
      settings: { isConfigured: vi.fn(), updateTerminalCredentials: vi.fn() },
      terminalConfig: { syncFromAdmin: vi.fn(), getSettings: vi.fn(), getFullConfig: vi.fn() },
    },
    setLanguage: vi.fn().mockResolvedValue(undefined),
    t: (key: string, options?: string | { defaultValue?: string }) =>
      typeof options === 'string' ? options : options?.defaultValue ?? key,
    toast: { error: vi.fn(), success: vi.fn(), custom: vi.fn(), dismiss: vi.fn() },
  };
});

vi.mock('../../lib', () => ({
  getBridge: () => mocks.bridge,
  isBrowser: () => false,
  onEvent: (name: string, listener: (value: unknown) => void) => {
    if (!mocks.listeners.has(name)) mocks.listeners.set(name, new Set());
    mocks.listeners.get(name)!.add(listener);
  },
  offEvent: (name: string, listener: (value: unknown) => void) => mocks.listeners.get(name)?.delete(listener),
}));
vi.mock('../contexts/i18n-context', () => ({
  useI18n: () => ({ language: 'en', setLanguage: mocks.setLanguage, t: mocks.t }),
}));
vi.mock('../contexts/theme-context', () => ({ ThemeProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock('../components/FullscreenAwareLayout', () => ({ default: ({ children }: React.PropsWithChildren) => children }));
vi.mock('../components/ui/PageLoadMotion', () => ({ default: ({ children }: React.PropsWithChildren) => children }));
vi.mock('../components/error/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: React.PropsWithChildren) => children }));
vi.mock('../components/recovery/RecoveryPanel', () => ({ default: () => null }));
vi.mock('../../config/environment', () => ({ updateAdminUrlFromSettings: async () => undefined }));
vi.mock('../../shared/supabase-config', () => ({ setSupabaseContext: vi.fn() }));
vi.mock('../lib/secure-session-cache', () => ({
  getSecureSessionSync: () => null, clearSecureSession: async () => undefined,
}));
vi.mock('react-hot-toast', () => ({ Toaster: () => null, toast: mocks.toast }));

// AppContent is outside this integration boundary. Do not initialize its native
// background services or mount operational screens in an onboarding test.
vi.mock('../contexts/shift-context', () => ({}));
vi.mock('../contexts/module-context', () => ({}));
vi.mock('../contexts/barcode-scanner-context', () => ({}));
vi.mock('../pages/LoginPage', () => ({}));
vi.mock('../components/ScreenCaptureControlRequestModal', () => ({}));
vi.mock('../components/SyncNotificationManager', () => ({}));
vi.mock('../components/CaptureNotificationManager', () => ({}));
vi.mock('../components/SyncStatusIndicator', () => ({}));
vi.mock('../components/callerid/CallerIdCustomerSearchModalHost', () => ({}));
vi.mock('../components/ui/DeferredModal', () => ({}));
vi.mock('../components/recovery/SyncRecoveryModal', () => ({}));
vi.mock('../components/PortaledToaster', () => ({}));
vi.mock('../services/ActivityTracker', () => ({}));
vi.mock('../services/ScreenCaptureHandler', () => ({}));
vi.mock('../components/AnimatedBackground', () => ({}));
vi.mock('../components/ThemeToggle', () => ({}));
vi.mock('../components/UpdateDialog', () => ({}));
vi.mock('../hooks/useBlockerRegistration', () => ({}));
vi.mock('../hooks/useFreezeWatchdog', () => ({}));
vi.mock('../hooks/useMenuVersionPolling', () => ({}));
vi.mock('../hooks/useAppEvents', () => ({}));
vi.mock('../hooks/useCallerIdNotifications', () => ({}));
vi.mock('../hooks/useAutoUpdater', () => ({}));
vi.mock('../hooks/useWindowState', () => ({}));
vi.mock('../services/RealtimeManager', () => ({}));
vi.mock('../services/RealtimeAuthService', () => ({}));
vi.mock('../services/DesktopRealtimeLifecycleCoordinator', () => ({}));
vi.mock('../services/terminal-realtime-client', () => ({}));
vi.mock('../services/ParitySyncCoordinator', () => ({}));
vi.mock('../hooks/useOrderStore', () => ({}));

import { ConfigGuard } from '../App';
import { clearTerminalCredentialCache } from '../services/terminal-credentials';

const emit = (name: string, data: unknown) => mocks.listeners.get(name)?.forEach((listener) => listener(data));
const identity = { terminal_id: 'TEST-TERMINAL', branch_id: 'fixture-branch', organization_id: 'fixture-org' };
const validCode = btoa(JSON.stringify({ key: 'fixture-api-key', url: 'https://admin.example', tid: identity.terminal_id }));

beforeEach(() => {
  localStorage.clear();
  clearTerminalCredentialCache();
  mocks.listeners.clear();
  mocks.bridge.settings.isConfigured.mockReset().mockResolvedValue({ configured: false });
  mocks.bridge.settings.updateTerminalCredentials.mockReset().mockImplementation(async () => {
    emit('terminal-credentials-updated', identity);
    emit('terminal-config-updated', identity);
    return { success: true };
  });
  mocks.bridge.terminalConfig.syncFromAdmin.mockReset().mockResolvedValue({ success: true });
  mocks.bridge.terminalConfig.getSettings.mockReset().mockResolvedValue({});
  mocks.bridge.terminalConfig.getFullConfig.mockReset().mockResolvedValue(identity);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

async function openOnboarding() {
  render(<ConfigGuard><div>Operational POS</div></ConfigGuard>);
  fireEvent.click(await screen.findByRole('button', { name: 'English' }));
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: validCode } });
  return input;
}

it('does not let native credential/config events mark an unfinished setup complete', async () => {
  mocks.bridge.terminalConfig.syncFromAdmin.mockRejectedValue('Network unavailable');
  await openOnboarding();
  fireEvent.click(screen.getByRole('button', { name: 'Connect & Sync' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable');
  expect(screen.queryByText('Operational POS')).not.toBeInTheDocument();
  expect(localStorage.getItem('pos-terminal-configured')).toBeNull();

  mocks.bridge.terminalConfig.syncFromAdmin.mockResolvedValue({ success: true });
  fireEvent.click(screen.getByRole('button', { name: 'Connect & Sync' }));
  await screen.findByRole('heading', { name: 'Your terminal is ready' });
  expect(localStorage.getItem('pos-terminal-configured')).toBe('1');
});

it.each(['credentials', 'sync'])('keeps onboarding mounted when the %s stage emits an auth pause before failing', async (stage) => {
  const target = stage === 'credentials'
    ? mocks.bridge.settings.updateTerminalCredentials : mocks.bridge.terminalConfig.syncFromAdmin;
  target.mockImplementation(async () => {
    emit('terminal-auth-paused', { source: 'onboarding', errorCode: 'terminal_auth_paused' });
    throw 'Terminal access is paused';
  });
  await openOnboarding();
  fireEvent.click(screen.getByRole('button', { name: 'Connect & Sync' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Terminal access is paused');
  expect(screen.getByRole('button', { name: 'Connect & Sync' })).toBeEnabled();
  expect(screen.queryByText('Operational POS')).not.toBeInTheDocument();
  expect(localStorage.getItem('pos-terminal-configured')).toBeNull();
  expect(mocks.toast.custom).not.toHaveBeenCalled();
});

it('preserves auth-pause recovery for a configured POS and stops promoting state after a reset', async () => {
  mocks.bridge.settings.isConfigured.mockResolvedValue({ configured: true });
  render(<ConfigGuard><div>Operational POS</div></ConfigGuard>);
  await screen.findByText('Operational POS');
  act(() => emit('terminal-auth-paused', { errorCode: 'terminal_auth_paused' }));
  expect(screen.getByText('Operational POS')).toBeInTheDocument();
  expect(mocks.toast.custom).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('pos-terminal-configured')).toBe('1');

  act(() => {
    emit('app:reset', { reason: 'terminal_deleted' });
    emit('terminal-credentials-updated', identity);
    emit('terminal-config-updated', identity);
    emit('terminal-auth-paused', { errorCode: 'terminal_auth_paused' });
  });
  await waitFor(() => expect(screen.queryByText('Operational POS')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument();
  expect(localStorage.getItem('pos-terminal-configured')).toBeNull();
  expect(mocks.toast.custom).toHaveBeenCalledTimes(1);
});
