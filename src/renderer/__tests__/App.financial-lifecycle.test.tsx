import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShiftFinancialOpeningView } from '../../lib/ipc-contracts';
import type { StaffShift } from '../types';

type Kids = { children?: React.ReactNode };

const fixture = vi.hoisted(() => {
  const noop = () => undefined;
  return {
    browser: true,
    order: [] as string[],
    logout: null as Promise<void> | null,
    shiftApi: null as ReturnType<(typeof import('../contexts/shift-context'))['useShift']> | null,
    i18n: { t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key), language: 'en' },
    orders: { silentRefresh: async () => undefined },
    windowState: { isFullscreen: false, isMaximized: false },
    updater: {
      hydrated: false, checking: false, downloading: false, ready: false, error: null, available: false,
      updateInfo: null, progress: null, currentVersion: 'test', installPending: false, installingVersion: null,
      downloadedVersion: null, updateDialogOpen: false, openUpdateDialog: noop, closeUpdateDialog: noop,
      downloadUpdate: noop, cancelDownload: noop, installUpdate: noop, scheduleInstallOnNextRestart: noop,
      checkForUpdates: noop,
    },
    bridge: {
      settings: { isConfigured: vi.fn() },
      secureSession: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
      staffAuth: { validateSession: vi.fn() },
      auth: { login: vi.fn(), logout: vi.fn() },
      printer: { listJobs: vi.fn() },
      terminalConfig: {
        getOrganizationId: vi.fn(), getBranchId: vi.fn(), getTerminalId: vi.fn(), getSetting: vi.fn(),
        getSettings: vi.fn(), getFullConfig: vi.fn(), refresh: vi.fn(), syncFromAdmin: vi.fn(),
      },
      shifts: { getActive: vi.fn(), getActiveByTerminal: vi.fn(), getActiveByTerminalLoose: vi.fn(), getById: vi.fn() },
      shiftFinancialOpening: { begin: vi.fn(), authorize: vi.fn(), status: vi.fn(), clearAuthorization: vi.fn() },
    },
  };
});

vi.mock('../../lib', async (original) => ({
  ...(await original<typeof import('../../lib')>()),
  getBridge: () => fixture.bridge,
  isBrowser: () => fixture.browser,
}));
vi.mock('../../config/environment', async (original) => ({
  ...(await original<typeof import('../../config/environment')>()),
  updateAdminUrlFromSettings: async () => undefined,
}));
vi.mock('react-hot-toast', async (original) => ({ ...(await original<typeof import('react-hot-toast')>()), Toaster: () => null }));
vi.mock('../../lib/i18n', () => ({ default: {} }));
vi.mock('../contexts/i18n-context', () => ({ I18nProvider: ({ children }: Kids) => <>{children}</>, useI18n: () => fixture.i18n }));
vi.mock('../contexts/theme-context', () => ({ ThemeProvider: ({ children }: Kids) => <>{children}</> }));
vi.mock('../contexts/module-context', () => ({ ModuleProvider: ({ children }: Kids) => <>{children}</> }));
vi.mock('../contexts/barcode-scanner-context', () => ({ BarcodeScannerProvider: ({ children }: Kids) => <>{children}</> }));
vi.mock('../pages/CustomerDisplayPage', () => ({
  default: () => <div data-testid="customer-display" />,
  CustomerDisplayProvider: ({ children }: Kids) => <>{children}</>,
}));
vi.mock('../pages/KitchenDisplayPage', () => ({
  default: () => <div data-testid="kitchen-display" />,
  KitchenDisplayProvider: ({ children }: Kids) => <>{children}</>,
}));
vi.mock('../pages/LoginPage', async () => {
  const { useShift } = await import('../contexts/shift-context');
  return { default: function LoginPageStub() { fixture.shiftApi = useShift(); return <div data-testid="login" />; } };
});
// The real layout receives App's actual handleLogout; the stub only exposes it.
vi.mock('../components/RefactoredMainLayout', async () => {
  const { useShift } = await import('../contexts/shift-context');
  return {
    default: function LayoutStub({ onLogout }: { onLogout: () => Promise<void> }) {
      fixture.shiftApi = useShift();
      return <button type="button" data-testid="layout" onClick={() => { fixture.logout = onLogout(); }}>logout</button>;
    },
  };
});
vi.mock('../pages/OnboardingPage', () => ({ default: () => <div data-testid="onboarding" /> }));
vi.mock('../pages/NewOrderPage', () => ({ default: () => null }));
vi.mock('../components/modals/ConnectionSettingsModal', () => ({ default: () => null }));
vi.mock('../hooks/useLocalPreparation', () => ({ LocalPreparationScopeSync: () => null }));
vi.mock('../components/error/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: Kids) => <>{children}</> }));
vi.mock('../components/ScreenCaptureControlRequestModal', () => ({ ScreenCaptureControlRequestModal: () => null }));
vi.mock('../components/SyncNotificationManager', () => ({ SyncNotificationManager: () => null }));
vi.mock('../components/CaptureNotificationManager', () => ({ CaptureNotificationManager: () => null }));
vi.mock('../components/notices/CancellationNoticeManager', () => ({ CancellationNoticeManager: () => null }));
// The release's global incoming-order alert (1.4.120) mounts in App too.
vi.mock('../components/notices/IncomingOrderAlertManager', () => ({ IncomingOrderAlertManager: () => null }));
vi.mock('../components/SyncStatusIndicator', () => ({ SyncStatusIndicator: () => null }));
vi.mock('../components/callerid/CallerIdCustomerSearchModalHost', () => ({ CallerIdCustomerSearchModalHost: () => null }));
vi.mock('../components/ui/DeferredModal', () => ({ DeferredModal: () => null }));
vi.mock('../components/recovery/SyncRecoveryModal', () => ({ default: () => null }));
vi.mock('../components/ui/PageLoadMotion', () => ({ default: ({ children }: Kids) => <>{children}</> }));
vi.mock('../components/PortaledToaster', () => ({ default: () => null }));
vi.mock('../components/AnimatedBackground', () => ({ default: () => null }));
vi.mock('../components/ThemeToggle', () => ({ default: () => null }));
vi.mock('../components/FullscreenAwareLayout', () => ({ default: ({ children }: Kids) => <>{children}</> }));
vi.mock('../components/UpdateDialog', () => ({ UpdateDialog: () => null }));
vi.mock('../services/ActivityTracker', () => ({ ActivityTracker: { setContext: () => undefined } }));
vi.mock('../services/ScreenCaptureHandler', () => ({ screenCaptureHandler: { setIdleSessionPollingEnabled: () => undefined } }));
vi.mock('../services/RealtimeManager', () => ({ DesktopRealtimeManager: class {} }));
vi.mock('../services/RealtimeAuthService', () => ({ RealtimeAuthService: class {} }));
vi.mock('../services/DesktopRealtimeLifecycleCoordinator', () => ({ DesktopRealtimeLifecycleCoordinator: class {} }));
vi.mock('../services/terminal-realtime-client', () => ({ createTerminalRealtimeSession: () => null }));
vi.mock('../services/ParitySyncCoordinator', () => ({
  emitParityQueueStatus: () => undefined,
  runParitySyncCycle: async () => undefined,
  PARITY_QUEUE_STATUS_EVENT: 'parity-queue-status',
  PARITY_SYNC_STATUS_EVENT: 'parity-sync-status',
  REALTIME_STATUS_EVENT: 'realtime-status',
}));
vi.mock('../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }));
vi.mock('../hooks/useFreezeWatchdog', () => ({ useFreezeWatchdog: () => undefined }));
vi.mock('../hooks/useMenuVersionPolling', () => ({ useMenuVersionPolling: () => undefined }));
vi.mock('../hooks/useCallerIdNotifications', () => ({ useCallerIdNotifications: () => undefined }));
vi.mock('../hooks/useAutoUpdater', () => ({ useAutoUpdater: () => fixture.updater }));
vi.mock('../hooks/useWindowState', () => ({ useWindowState: () => fixture.windowState }));
vi.mock('../hooks/useOrderStore', () => ({
  useOrderStore: (select: (state: typeof fixture.orders) => unknown) => select(fixture.orders),
}));

import App from '../App';
import { emitCompatEvent } from '../../lib';
import { resetBridge, setBridge } from '../../lib/ipc-adapter';
import { __resetForTesting, setSecureSession } from '../lib/secure-session-cache';
import { clearTerminalCredentialCache } from '../services/terminal-credentials';
import {
  financialOpening,
  FinancialOpeningInvalidatedError,
  isFinancialOpeningAuthorizedFor,
} from '../lib/financial-opening';

vi.setConfig({ testTimeout: 20_000 });

const SCOPE = { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'register-public-01' };
const CASHIER = 'cashier-1';
const SESSION = { staffId: CASHIER, staffName: 'Cashier', role: { name: 'cashier' }, sessionId: 'session-1', ...SCOPE };
const bridge = fixture.bridge;
const native = bridge.shiftFinancialOpening;
function opening(patch: Partial<ShiftFinancialOpeningView> = {}): ShiftFinancialOpeningView {
  return { openingKey: 'key-1', shiftId: 'shift-1', drawerId: 'drawer-1', staffId: CASHIER, ...SCOPE, openingCents: 1250,
    currency: 'CHF', businessDate: '2026-09-29', checkedInAt: '2026-09-29T08:10:11.000Z', isDayStart: true,
    calculationVersion: 2, state: 'confirmed_usable', usable: true, hostedAuthorization: { state: 'authorized', expiresAt: null },
    lastPendingCode: null, drawer: null, ...patch };
}
function row(view = opening()) {
  return { id: view.shiftId, staff_id: view.staffId, staff_name: 'Cashier', branch_id: view.branchId, terminal_id: view.terminalId,
    role_type: 'cashier', check_in_time: view.checkedInAt, opening_cash_amount: view.openingCents / 100, status: 'active',
    total_orders_count: 0, total_sales_amount: 0, total_cash_sales: 0, total_card_sales: 0,
    created_at: view.checkedInAt, updated_at: view.checkedInAt } as unknown as StaffShift;
}
const beginInput = { openingKey: 'key-1', openingCents: 1250, currency: 'CHF', staffId: CASHIER, staffName: 'Cashier', pin: '1111' } as
  Parameters<typeof financialOpening.begin>[0];
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const record = (label: string, value: unknown) => async () => { fixture.order.push(label); return value; };
const clears = () => native.clearAuthorization.mock.calls.length;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const appears = (testId: string) => screen.findByTestId(testId, undefined, { timeout: 8_000 });

async function mountSignedIn() {
  await setSecureSession(SESSION as Parameters<typeof setSecureSession>[0]);
  render(<App />);
  await appears('layout');
  await settle(); await settle();
  act(() => fixture.shiftApi!.setActiveShiftImmediate(row()));
  await settle();
  expect(fixture.shiftApi?.activeShift?.id).toBe('shift-1');
  expect(localStorage.getItem('activeShift')).toContain('shift-1');
  fixture.order.length = 0;
}

describe('App dedicated financial authority lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // secure-session-cache reads the adapter bridge directly.
    setBridge(fixture.bridge as unknown as Parameters<typeof setBridge>[0]);
    localStorage.clear();
    __resetForTesting();
    clearTerminalCredentialCache();
    window.history.replaceState(null, '', '/');
    Object.assign(fixture, { browser: true, logout: null, shiftApi: null });
    fixture.order.length = 0;
    bridge.settings.isConfigured.mockResolvedValue({ configured: true, reason: 'configured' });
    bridge.secureSession.get.mockResolvedValue(null);
    bridge.secureSession.set.mockResolvedValue(undefined);
    bridge.secureSession.clear.mockImplementation(record('session-clear', undefined));
    bridge.staffAuth.validateSession.mockResolvedValue({ valid: true });
    bridge.auth.logout.mockImplementation(record('logout', { success: true }));
    bridge.printer.listJobs.mockResolvedValue({ success: true, jobs: [] });
    bridge.terminalConfig.getOrganizationId.mockResolvedValue(SCOPE.organizationId);
    bridge.terminalConfig.getBranchId.mockResolvedValue(SCOPE.branchId);
    bridge.terminalConfig.getTerminalId.mockResolvedValue(SCOPE.terminalId);
    bridge.terminalConfig.getSetting.mockResolvedValue(null);
    bridge.terminalConfig.getSettings.mockResolvedValue(null);
    bridge.terminalConfig.getFullConfig.mockResolvedValue({
      terminal_id: SCOPE.terminalId, branch_id: SCOPE.branchId, organization_id: SCOPE.organizationId,
    });
    bridge.terminalConfig.refresh.mockResolvedValue(undefined);
    bridge.terminalConfig.syncFromAdmin.mockResolvedValue({ success: true });
    bridge.shifts.getActive.mockResolvedValue(null);
    bridge.shifts.getActiveByTerminal.mockResolvedValue(null);
    bridge.shifts.getActiveByTerminalLoose.mockResolvedValue(null);
    bridge.shifts.getById.mockResolvedValue(null);
    native.begin.mockResolvedValue({ success: true, opening: opening({ state: 'pending', usable: false }) });
    native.authorize.mockResolvedValue({ success: true, opening: opening() });
    native.status.mockResolvedValue({ success: true, openings: [opening()] });
    native.clearAuthorization.mockImplementation(record('clear', { success: true }));
  });
  afterEach(async () => {
    cleanup();
    window.history.replaceState(null, '', '/');
    // An explicit successful clear leaves the module-level barrier clean for the next case.
    native.clearAuthorization.mockResolvedValue({ success: true });
    await financialOpening.clearAuthorization();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resetBridge();
  });

  it('handleLogout starts the dedicated clear before awaiting auth.logout, fences late replies and keeps the shift', async () => {
    await mountSignedIn();
    const storedShift = localStorage.getItem('activeShift');
    const lateBegin = deferred();
    const lateStatus = deferred();
    const lateRow = deferred();
    native.begin.mockReturnValueOnce(lateBegin.promise);
    native.status.mockReturnValueOnce(lateStatus.promise);
    bridge.shifts.getById.mockReturnValueOnce(lateRow.promise);
    const begin = financialOpening.begin(beginInput);
    const status = financialOpening.status('key-1');
    const actualRow = financialOpening.readConfirmedShift(opening());
    expect(native.begin).toHaveBeenCalledTimes(1);
    expect(bridge.shifts.getById).toHaveBeenCalledWith('shift-1');

    const heldClear = deferred();
    const heldLogout = deferred();
    native.clearAuthorization.mockImplementationOnce(() => { fixture.order.push('clear'); return heldClear.promise; });
    bridge.auth.logout.mockImplementationOnce(() => { fixture.order.push('logout'); return heldLogout.promise; });
    fireEvent.click(screen.getByTestId('layout'));
    expect(fixture.order).toEqual(['clear', 'logout']);

    const nextBegin = financialOpening.begin(beginInput);
    lateBegin.resolve({ success: true, opening: opening() });
    lateStatus.resolve({ success: true, openings: [opening()] });
    lateRow.resolve({ success: true, data: row() });
    await expect(begin).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    await expect(status).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    await expect(actualRow).resolves.toBeNull();
    expect(isFinancialOpeningAuthorizedFor({ ...SCOPE, staffId: CASHIER })).toBe(false);
    expect(native.begin).toHaveBeenCalledTimes(1);

    heldClear.resolve({ success: false });
    await expect(nextBegin).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    await expect(financialOpening.authorize('key-1', '1111')).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    expect(native.begin).toHaveBeenCalledTimes(1);
    expect(native.authorize).not.toHaveBeenCalled();

    await act(async () => { heldLogout.resolve({ success: true }); await fixture.logout; });
    await appears('login');
    expect(fixture.order).toEqual(['clear', 'logout', 'session-clear']);
    expect(fixture.shiftApi?.activeShift?.id).toBe('shift-1');
    expect(localStorage.getItem('activeShift')).toBe(storedShift);
  });

  it('the actual session-timeout event fences authority and ends only the session', async () => {
    await mountSignedIn();
    const storedShift = localStorage.getItem('activeShift');
    act(() => { emitCompatEvent('session-timeout', { reason: 'idle' }); });
    expect(fixture.order).toEqual(['clear', 'session-clear']);
    await appears('login');
    expect(bridge.auth.logout).not.toHaveBeenCalled();
    expect(fixture.shiftApi?.activeShift?.id).toBe('shift-1');
    expect(localStorage.getItem('activeShift')).toBe(storedShift);
  });

  it.each([
    ['app:reset', ['clear', 'session-clear']],
    ['terminal-auth-paused', ['clear']],
  ])('%s always fences dedicated financial authority', async (event, expected) => {
    await mountSignedIn();
    act(() => { emitCompatEvent(event, { reason: 'terminal_deleted' }); });
    expect(fixture.order).toEqual(expected);
  });

  it('a not-configured terminal fences authority before clearing the stale session; auth pause still fences', async () => {
    fixture.browser = false;
    bridge.settings.isConfigured.mockResolvedValue({ configured: false, reason: 'missing terminal' });
    render(<App />);
    await appears('onboarding');
    expect(fixture.order).toEqual(['clear', 'session-clear']);
    act(() => { emitCompatEvent('terminal-auth-paused', {}); });
    expect(fixture.order).toEqual(['clear', 'session-clear', 'clear']);
  });

  it.each([
    ['rejected', () => bridge.staffAuth.validateSession.mockResolvedValue({ valid: false })],
    ['unverifiable', () => bridge.staffAuth.validateSession.mockRejectedValue(new Error('validation unavailable'))],
  ])('a %s restored session fences authority before clearing it', async (_label, arrange) => {
    fixture.browser = false;
    arrange();
    await setSecureSession(SESSION as Parameters<typeof setSecureSession>[0]);
    render(<App />);
    await appears('login');
    expect(bridge.staffAuth.validateSession).toHaveBeenCalledTimes(1);
    expect(fixture.order).toEqual(['clear', 'session-clear']);
  });

  it('the main POS verifies canonical terminal scope while signed out and without realtime', async () => {
    render(<App />);
    await appears('login');
    await settle();
    expect(clears()).toBe(0);
    bridge.terminalConfig.getBranchId.mockResolvedValue('branch-2');
    await act(async () => { emitCompatEvent('terminal-credentials-updated', {}); });
    await settle();
    expect(clears()).toBe(1);
  });

  it('a connected display window never mounts the financial lifecycle or its listeners', async () => {
    fixture.browser = false;
    window.history.replaceState(null, '', '/#/?externalDisplay=customer');
    render(<App />);
    await appears('customer-display');
    for (const event of ['terminal-settings-updated', 'terminal-config-updated', 'terminal-credentials-updated',
      'terminal-auth-paused', 'app:reset', 'session-timeout']) {
      act(() => { emitCompatEvent(event, {}); });
    }
    await settle();
    expect(native.clearAuthorization).not.toHaveBeenCalled();
    expect(bridge.terminalConfig.getOrganizationId).not.toHaveBeenCalled();
    expect(bridge.terminalConfig.getBranchId).not.toHaveBeenCalled();
    expect(bridge.terminalConfig.getTerminalId).not.toHaveBeenCalled();
    expect(bridge.settings.isConfigured).not.toHaveBeenCalled();
    expect(bridge.secureSession.get).not.toHaveBeenCalled();
  });
});
