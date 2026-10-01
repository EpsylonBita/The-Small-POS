import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  identity: { organizationId: 'org', branchId: 'branch', terminalId: 'terminal', isReady: true },
  enabled: true, snapshot: null as any, rows: [] as any[],
  // Native lease of the customer presentation: it runs while `active` and closes only by its current token.
  active: false, token: null as string | null, displayId: null as string | null, phase: 'active', tokens: [] as string[],
  screens: [] as any[], others: [] as any[],
  events: new Map<string, Set<() => void>>(), local: { orders: [] as any[] }, storage: new Map<string, string>(),
  getAll: vi.fn(), getLocal: vi.fn(), setLocal: vi.fn(),
  api: vi.fn(), fetch: vi.fn(), invoke: vi.fn(), close: vi.fn(), subscribe: vi.fn(), clipboard: vi.fn(),
  i18n: { language: 'en', changeLanguage: vi.fn() }, t: (_key: string, fallback?: string) => fallback || _key,
}));
const CD = 'customer_display';
const screenOf = (index: number, id: string, name: string, extra: Record<string, unknown> = {}) => ({
  index, id, name, isPrimary: false, hostsPos: false, external: true, size: { width: 1920, height: 1080 }, ...extra,
});
const CASHIER = screenOf(0, 'primary', 'Cashier screen', { isPrimary: true, hostsPos: true, external: false });
const KITCHEN_ON_HDMI_2 = { contentType: 'kitchen_display', label: 'kitchen-display', displayId: 'hdmi-2', token: 'kds-token', state: 'active' };
const presentations = (): any[] => [
  ...(state.active ? [{ contentType: CD, label: 'customer-display', displayId: state.displayId, token: state.token, state: state.phase }] : []),
  ...state.others,
];
const occupant = (id: unknown): string | null => presentations().find(item => item.displayId === id)?.contentType ?? null;
const capabilities = () => ({
  success: true, supported: true, primaryDisplayId: 'primary', posDisplayId: 'primary',
  displays: state.screens.map(display => ({ available: display.external === true && !occupant(display.id), occupiedBy: occupant(display.id), ...display })),
  occupiedDisplayIds: presentations().map(item => item.displayId), activePresentations: presentations(),
});
const issue = () => { const token = `cd-token-${state.tokens.length + 1}`; state.tokens.push(token); return token; };
const refuse = (code: string, error: string, occupiedBy: string | null = null) => ({ success: false, supported: true, code, error, contentType: CD, label: 'customer-display', occupiedBy });
const isExternal = (display: any) => display.external === true && display.isPrimary === false && display.hostsPos === false && Boolean(display.id);
// Native lease rules: Auto takes the first free external screen; an explicit id is validated and never redirected.
const nativeOpen = (params: any): any => {
  const requested: string | undefined = params?.displayId;
  if (state.active) {
    if (state.phase !== 'active') return refuse('display_busy', 'The display is still starting or stopping.');
    if (requested !== undefined && requested !== state.displayId) return refuse('display_content_active', 'This display already runs on another screen. Stop it first.');
    state.token = issue(); // reopening the running content rotates its token
    return { success: true, supported: true, contentType: CD, label: 'customer-display', token: state.token, displayId: state.displayId, activeDisplayId: state.displayId, reused: true };
  }
  const target = requested === undefined
    ? state.screens.find(display => isExternal(display) && !occupant(display.id))
    : state.screens.find(display => display.id === requested);
  if (!target) return requested === undefined ? refuse('no_external_display', 'No free external screen is connected.') : refuse('display_not_found', 'The selected screen is no longer connected.');
  if (!isExternal(target)) return refuse('display_reserved_for_pos', 'The cashier screen is never used.');
  if (occupant(target.id)) return refuse('display_occupied', 'This screen is already used by another display. Choose a free screen.', occupant(target.id));
  state.active = true; state.phase = 'active'; state.displayId = target.id; state.token = issue();
  return { success: true, supported: true, contentType: CD, label: 'customer-display', token: state.token, displayId: target.id, activeDisplayId: target.id, reused: false, display: { ...target } };
};
// A stale token is a no-op; a tokenless close would stop any session (afterEach rejects it).
const nativeClose = async (params: any) => {
  const current = params?.contentType === CD && state.active && (params.token === undefined || params.token === state.token);
  if (current) { state.active = false; state.token = null; state.displayId = null; }
  return { success: true, closed: current, stale: !current, activePresentations: presentations() };
};
const bridge = {
  adminApi: { fetchFromAdmin: state.api }, invoke: state.invoke, clipboard: { writeText: state.clipboard },
  orders: { getAll: state.getAll }, settings: { getLocal: state.getLocal, set: state.setLocal },
  externalDisplay: {
    getCapabilities: vi.fn(async () => capabilities()),
    open: vi.fn(async (params: any) => nativeOpen(params)), close: state.close,
  },
};
vi.mock('../../../lib', () => ({ getBridge: () => bridge,
  onEvent: (key: string, handler: () => void) => { if (!state.events.has(key)) state.events.set(key, new Set()); state.events.get(key)!.add(handler); },
  offEvent: (key: string, handler: () => void) => state.events.get(key)?.delete(handler),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t, i18n: state.i18n }) }));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('../../contexts/module-context', () => ({ useModules: () => ({ isModuleEnabled: () => state.enabled }) }));
vi.mock('../../hooks/useResolvedPosIdentity', () => ({ useResolvedPosIdentity: () => state.identity }));
vi.mock('../../hooks/useOrderStore', () => ({ useOrderStore: (selector: any) => selector(state.local) }));
vi.mock('../../services/SubscriptionManager', () => ({ subscriptionManager: { subscribe: state.subscribe } }));
vi.mock('framer-motion', () => ({ motion: Object.fromEntries(['div', 'section', 'button'].map(tag => [tag, ({ children, variants, initial, animate, ...props }: any) => React.createElement(tag, props, children)])) }));
import CustomerDisplayPage, { CustomerDisplayProvider } from '../CustomerDisplayPage';
import { localPreparationStore } from '../../services/KdsLocalPhaseStore';
import { formatCompactOrderNumberForDisplay } from '../../utils/orderNumberUtils';

const SCOPE = 'org|branch|terminal';
const PHASE_KEY = 'local.kds_phase_org_branch_terminal';
const AT = '2026-09-28T10:00:00.000Z';
const order = (id: string, extra: Record<string, unknown> = {}) => ({
  id, order_number: '42', status: 'pending', order_type: 'pickup', payment_status: 'unpaid',
  organization_id: 'org', branch_id: 'branch', terminal_id: 'terminal', created_at: AT, updated_at: AT, ...extra,
});
const withMarks = async (marks: Record<string, unknown>) => {
  state.storage.set(PHASE_KEY, JSON.stringify({ v: 2, scope: SCOPE, marks }));
  await act(async () => { await localPreparationStore.refresh(SCOPE); });
};
const flush = () => act(async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const fire = (event: string) => act(() => { state.events.get(event)?.forEach(handler => handler()); });
const shown = () => (state.snapshot?.displayOrders ?? []).map((row: any) => `${row.order_id}:${row.status}`).sort();
const externalButton = () => screen.getByRole('button', { name: 'External Display' });
const screenButton = (name: string) => screen.getByRole('button', { name: new RegExp(name) });
const open = async () => { fireEvent.click(externalButton()); await flush(); };
const openCalls = () => bridge.externalDisplay.open.mock.calls.map(([params]) => params);
const closedTokens = () => state.close.mock.calls.map(([params]) => params?.token);
const published = () => state.invoke.mock.calls.filter(([command]) => command === 'customer-display-publish').map(([, payload]) => payload ?? null);
function Harness({ page = true }: { page?: boolean }) { return <CustomerDisplayProvider>{page ? <CustomerDisplayPage /> : <div>Orders</div>}</CustomerDisplayProvider>; }

describe('persistent Windows Customer Display owner (strictly local)', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.stubGlobal('fetch', state.fetch);
    state.enabled = true; state.snapshot = null; state.events.clear(); state.local.orders = []; state.storage.clear();
    state.active = false; state.token = null; state.displayId = null; state.phase = 'active'; state.tokens = []; state.others = [];
    state.screens = [CASHIER, screenOf(1, 'hdmi-1', 'Customer monitor')];
    state.identity = { organizationId: 'org', branchId: 'branch', terminalId: 'terminal', isReady: true };
    state.rows = [order('o1')];
    state.getAll.mockReset().mockImplementation(async () => state.rows.map(row => ({ ...row })));
    state.getLocal.mockReset().mockImplementation(async (key: string) => state.storage.get(key) ?? null);
    state.setLocal.mockReset().mockImplementation(async ({ category, key, value }: any) => { state.storage.set(`${category}.${key}`, value); return { success: true }; });
    [state.api, state.fetch, state.subscribe, state.clipboard].forEach(mock => mock.mockReset());
    bridge.externalDisplay.getCapabilities.mockReset().mockImplementation(async () => capabilities());
    bridge.externalDisplay.open.mockReset().mockImplementation(async (params: any) => nativeOpen(params));
    state.close.mockReset().mockImplementation(nativeClose);
    state.invoke.mockReset().mockImplementation(async (command, payload) => { if (command === 'customer-display-publish') state.snapshot = payload; if (command === 'customer-display-snapshot') return state.snapshot; });
    window.history.replaceState({}, '', '/');
    // App's LocalPreparationScopeSync selects the signed-in scope of the shared kitchen stages.
    localPreparationStore.resetForTests(); localPreparationStore.configure(SCOPE);
  });
  afterEach(() => {
    try {
      cleanup(); // unmount first so the owner's own cleanup closes are checked too
      // Every scenario: no display API, fetch, pairing link, clipboard or realtime channel; only the local display IPC.
      expect(state.api).not.toHaveBeenCalled(); expect(state.fetch).not.toHaveBeenCalled();
      expect(state.clipboard).not.toHaveBeenCalled(); expect(state.subscribe).not.toHaveBeenCalled();
      expect(state.invoke.mock.calls.map(([command]) => String(command)).filter(command => !command.startsWith('customer-display-'))).toEqual([]);
      // Every native close names the one presentation it may end; a tokenless close would stop any session.
      expect(state.close.mock.calls.filter(([params]) => typeof params?.token !== 'string' || params.token === '')).toEqual([]);
      // No presentation token ever reaches the customer-facing snapshot.
      const payloads = JSON.stringify(published());
      [...state.tokens, 'kds-token'].forEach(token => expect(payloads).not.toContain(token));
    } finally {
      cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); localPreparationStore.resetForTests();
    }
  });

  it('projects local orders with their kitchen stage; Collected leaves the screen and no order is written', async () => {
    state.rows = [
      order('o1', { customer_name: 'PRIVATE', notes: 'PRIVATE NOTE', items: [{ name: 'PRIVATE ITEM' }] }),
      order('o2', { status: 'confirmed' }),
      order('o3', { status: 'preparing' }),
      order('o4', { status: 'ready' }), // a canonical ready order stays until it is collected
      order('o5', { status: 'ready', supabase_id: 'cloud-5' }), // collected under its cloud id
      order('o6'), // an unpaid sale collected from the kitchen stays an active order elsewhere
    ];
    await withMarks({ o2: { phase: 'ready', at: AT }, 'cloud-5': { phase: 'collected', at: AT }, o6: { phase: 'collected', at: AT } });
    render(<Harness />); await flush(); await open();
    expect(shown()).toEqual(['o1:pending', 'o2:ready', 'o3:preparing', 'o4:ready']);
    expect(JSON.stringify(state.snapshot)).not.toContain('PRIVATE');
    expect(state.snapshot.displayOrders[0]).toEqual(expect.objectContaining({ order_number: formatCompactOrderNumberForDisplay('42') }));
    // The kitchen moves an order forward locally; the screen follows without another order read.
    const reads = state.getAll.mock.calls.length;
    await act(async () => { await localPreparationStore.mark(SCOPE, 'o1', 'ready', null); }); await flush();
    expect(shown()).toContain('o1:ready');
    expect(state.snapshot.displayOrders[0].order_id).toBe('o1'); // the newest stage change leads
    await act(async () => { await localPreparationStore.mark(SCOPE, 'o1', 'collected', 'ready'); }); await flush();
    expect(shown()).toEqual(['o2:ready', 'o3:preparing', 'o4:ready']);
    expect(state.getAll).toHaveBeenCalledTimes(reads);
    // Only the kitchen's stage marks were stored; order status, payment and closure never change.
    expect(state.setLocal.mock.calls.map(([update]) => `${update.category}.${update.key}`)).toEqual([PHASE_KEY, PHASE_KEY]);
  });

  it("shows only this terminal's active pickup and takeaway orders, offline-only ones included, once each", async () => {
    state.rows = [
      order('offline', { supabase_id: null, sync_status: 'pending' }),
      order('takeaway', { order_type: 'takeaway', display_order_number: 'T-7' }),
      order('dup', { supabase_id: 'cloud-dup' }), order('dup-copy', { supabase_id: 'cloud-dup' }),
      order('completed', { status: 'completed' }), order('cancelled', { status: 'cancelled' }), order('refunded', { status: 'refunded' }),
      order('closed', { is_closed: 1 }), order('ghost', { is_ghost: true }), order('z-report', { z_report_id: 'z-1' }),
      order('repair', { order_context: 'repair_settlement' }),
      order('dine-in', { order_type: 'dine-in' }), order('delivery', { order_type: 'delivery' }), order('table', { order_type: 'takeaway', table_number: 4 }),
      order('other-org', { organization_id: 'org-2' }), order('other-branch', { branch_id: 'branch-2' }), order('other-terminal', { terminal_id: 'terminal-2' }),
    ];
    render(<Harness />); await flush(); await open();
    expect(shown()).toEqual(['dup:pending', 'offline:pending', 'takeaway:pending']);
  });

  it('keeps last good rows on a failed read, fails closed on a first read and ignores a delayed read of an old scope', async () => {
    state.getAll.mockRejectedValueOnce(new Error('database locked'));
    const view = render(<Harness />); await flush(); await open();
    expect(state.snapshot).toMatchObject({ isLoading: true, displayOrders: [] });
    expect(screen.getByText('database locked')).toBeInTheDocument();
    fire('order-created'); await tick(160);
    expect(state.snapshot).toMatchObject({ isLoading: false }); expect(shown()).toEqual(['o1:pending']);
    state.getAll.mockRejectedValueOnce(new Error('disk busy'));
    fire('order-status-updated'); await tick(160);
    expect(shown()).toEqual(['o1:pending']); expect(screen.getByText('disk busy')).toBeInTheDocument();
    state.getAll.mockResolvedValueOnce({ rows: [] });
    fire('order-deleted'); await tick(160);
    expect(shown()).toEqual(['o1:pending']); expect(screen.getByText('Local orders are unreadable')).toBeInTheDocument();

    let release!: (rows: unknown[]) => void;
    state.getAll.mockImplementationOnce(() => new Promise(done => { release = done; }));
    fire('order-created'); await tick(160);
    state.identity = { ...state.identity, branchId: 'branch-2' };
    state.rows = [order('b2', { branch_id: 'branch-2' })];
    act(() => localPreparationStore.configure('org|branch-2|terminal'));
    view.rerender(<Harness />); await flush();
    expect(state.snapshot).toBeNull(); expect(state.active).toBe(false);
    await act(async () => release([order('stale', { organization_id: undefined, branch_id: undefined })])); await flush();
    await open();
    expect(shown()).toEqual(['b2:pending']);
  });

  it('fails closed while kitchen stages are unreadable and recovers on manual refresh', async () => {
    localPreparationStore.resetForTests(); state.storage.set(PHASE_KEY, '{broken'); localPreparationStore.configure(SCOPE);
    render(<Harness />); await flush(); await open();
    expect(state.snapshot).toMatchObject({ isLoading: true, displayOrders: [] });
    expect(screen.getByText('Stored kitchen state is unreadable')).toBeInTheDocument();
    state.storage.delete(PHASE_KEY);
    fireEvent.click(screen.getByLabelText('Refresh')); await flush();
    expect(state.snapshot).toMatchObject({ isLoading: false }); expect(shown()).toEqual(['o1:pending']);
    expect(state.setLocal).not.toHaveBeenCalled();
  });

  it('keeps projecting after navigation: local events, store reloads and DB-only sync refresh it, nothing polls', async () => {
    const view = render(<Harness />); await flush(); expect(state.getAll).toHaveBeenCalledTimes(1);
    await open(); view.rerender(<Harness page={false} />); await flush();
    expect(state.getAll).toHaveBeenCalledTimes(1);
    state.rows = [order('o1'), order('o2')];
    for (let index = 0; index < 10; index++) ['order-created', 'order-status-updated', 'order-deleted'].forEach(fire);
    await tick(149); expect(state.getAll).toHaveBeenCalledTimes(1);
    await tick(1); expect(state.getAll).toHaveBeenCalledTimes(2); expect(shown()).toEqual(['o1:pending', 'o2:pending']);
    fire('sync:complete'); await tick(160); expect(state.getAll).toHaveBeenCalledTimes(3);
    fire('sync:complete'); await tick(160); expect(state.getAll).toHaveBeenCalledTimes(3);
    fire('online'); await tick(60000); expect(state.getAll).toHaveBeenCalledTimes(3);
    fire('sync:complete'); await tick(160); expect(state.getAll).toHaveBeenCalledTimes(4);
    state.local.orders = [order('o1')]; view.rerender(<Harness page={false} />); await tick(160);
    expect(state.getAll).toHaveBeenCalledTimes(5);
    state.active = false; await tick(2000); // the monitor window closed at OS level
    expect(state.snapshot).toBeNull();
    const reads = state.getAll.mock.calls.length; fire('order-created'); await tick(60000);
    expect(state.getAll).toHaveBeenCalledTimes(reads);
  });

  it('the receiver window only reads the local snapshot command', async () => {
    state.snapshot = { displayOrders: [{ order_id: 'o1', order_number: '42', status: 'ready', created_at: AT, updated_at: AT }], isLoading: false, isDark: true, locale: 'en' };
    const reads = state.getLocal.mock.calls.length;
    window.history.replaceState({}, '', '/?externalDisplay=customer_display');
    render(<CustomerDisplayPage />); await flush(); await tick(1500);
    expect(screen.getByText('Ready for pickup')).toBeInTheDocument();
    const commands = state.invoke.mock.calls.map(([command]) => command);
    expect(commands.length).toBeGreaterThan(1); expect(new Set(commands)).toEqual(new Set(['customer-display-snapshot']));
    expect(state.getAll).not.toHaveBeenCalled(); expect(state.getLocal).toHaveBeenCalledTimes(reads);
    expect(bridge.externalDisplay.getCapabilities).not.toHaveBeenCalled(); expect(bridge.externalDisplay.open).not.toHaveBeenCalled();
  });

  it('entitlement revocation closes the screen, clears the projection and discards an in-flight read', async () => {
    const view = render(<Harness />); await flush(); await open();
    let complete!: (rows: unknown[]) => void;
    state.getAll.mockImplementationOnce(() => new Promise(done => { complete = done; }));
    fire('order-created'); await tick(160);
    state.enabled = false; view.rerender(<Harness />); await flush();
    expect(state.snapshot).toBeNull(); expect(closedTokens()).toEqual(['cd-token-1']); expect(state.active).toBe(false);
    await act(async () => complete([order('late')])); await flush(); expect(state.snapshot).toBeNull();
    const reads = state.getAll.mock.calls.length; fire('order-created'); await tick(60000);
    expect(state.getAll).toHaveBeenCalledTimes(reads);
  });

  it('identity change and logout clear the projection; manual stop clears the native snapshot', async () => {
    const view = render(<Harness />); await flush(); await open();
    fireEvent.click(screen.getByText('Stop External')); await flush(); expect(state.snapshot).toBeNull();
    await open(); expect(state.snapshot).not.toBeNull();
    state.identity = { ...state.identity, branchId: 'other' }; view.rerender(<Harness />); await flush();
    expect(state.snapshot).toBeNull(); expect(state.active).toBe(false);
    view.unmount(); await flush(); expect(state.snapshot).toBeNull();
    expect(closedTokens()).toEqual(['cd-token-1', 'cd-token-2']);
  });

  it('a late native open cannot survive logout', async () => {
    const view = render(<Harness />); await flush();
    let complete!: () => void;
    bridge.externalDisplay.open.mockImplementationOnce((params: any) => new Promise(done => { complete = () => done(nativeOpen(params)); }));
    fireEvent.click(externalButton()); await flush();
    view.unmount(); await flush(); expect(state.close).not.toHaveBeenCalled(); // nothing was owned yet
    await act(async () => complete()); await flush();
    expect(state.active).toBe(false); expect(state.snapshot).toBeNull();
    expect(closedTokens()).toEqual(['cd-token-1']); // only the late open's own presentation
  });

  it('Auto opens without naming a screen, Stop closes exactly the owned token and the snapshot stays public', async () => {
    state.screens.push(screenOf(2, 'hdmi-2', 'Menu TV'));
    render(<Harness />); await flush(); await open();
    expect(openCalls()).toEqual([{ contentType: CD }]);
    expect(state.displayId).toBe('hdmi-1');
    expect(screenButton('Customer monitor')).toHaveTextContent('Showing the customer display');
    expect(screenButton('Customer monitor')).toBeDisabled();
    // Only public rows and theme are published: no screens, capabilities or presentation token.
    expect(Object.keys(state.snapshot).sort()).toEqual(['displayOrders', 'isDark', 'isLoading', 'locale']);
    fireEvent.click(screen.getByText('Stop External')); await flush();
    expect(state.close.mock.calls).toEqual([[{ contentType: CD, token: 'cd-token-1' }]]);
    expect(state.active).toBe(false); expect(state.snapshot).toBeNull();
    expect(screen.getByText('External customer display stopped.')).toBeInTheDocument();
    expect(screenButton('Customer monitor')).toBeEnabled(); expect(externalButton()).toBeEnabled();
  });

  it('a chosen screen travels only as its id; a native refusal is shown without redirect or Auto retry', async () => {
    state.screens.push(screenOf(2, 'hdmi-2', 'Menu TV'), screenOf(3, 'hdmi-3', 'Bar TV'));
    render(<Harness />); await flush();
    // The kitchen took the menu TV after this page read the screens, which still call it free.
    state.others = [KITCHEN_ON_HDMI_2];
    expect(screenButton('Menu TV')).toBeEnabled();
    fireEvent.click(screenButton('Menu TV')); await flush();
    expect(openCalls()).toEqual([{ contentType: CD, displayId: 'hdmi-2' }]);
    expect(screen.getByText('This screen is already used by another display. Choose a free screen.')).toBeInTheDocument();
    expect(screenButton('Menu TV')).toBeDisabled(); // the refusal re-read the screens
    // The bar TV was unplugged meanwhile: refused as missing, never replaced by the free monitor.
    state.screens = state.screens.filter(display => display.id !== 'hdmi-3');
    fireEvent.click(screenButton('Bar TV')); await flush();
    expect(openCalls()).toEqual([{ contentType: CD, displayId: 'hdmi-2' }, { contentType: CD, displayId: 'hdmi-3' }]);
    expect(screen.getByText('The selected screen is no longer connected.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bar TV/ })).toBeNull();
    await tick(10000);
    expect(openCalls()).toHaveLength(2); expect(state.active).toBe(false); expect(state.snapshot).toBeNull();
    expect(state.close).not.toHaveBeenCalled();
  });

  it('offers only explicit external screens; kitchen-held or closing screens stay disabled and closing is not live', async () => {
    state.screens = [CASHIER];
    render(<Harness />); await flush();
    // Only the cashier's screen: nothing is offered and Auto cannot cover the POS.
    expect(screen.getByText(/Cable displays and OS-level wireless displays appear here/)).toBeInTheDocument();
    expect(externalButton()).toBeDisabled();
    state.screens = [
      CASHIER,
      screenOf(1, 'hdmi-1', 'Customer monitor'),
      screenOf(2, 'hdmi-2', 'Kitchen TV'),
      screenOf(3, 'hdmi-3', 'Unknown TV', { external: undefined }),
      screenOf(4, '', 'Nameless TV'),
      screenOf(5, undefined as unknown as string, 'Legacy TV'),
    ];
    state.others = [KITCHEN_ON_HDMI_2];
    fireEvent.click(screen.getByLabelText('Refresh')); await flush();
    ['Cashier screen', 'Unknown TV', 'Nameless TV', 'Legacy TV'].forEach(name => expect(screen.queryByRole('button', { name: new RegExp(name) })).toBeNull());
    expect(screenButton('Kitchen TV')).toBeDisabled(); expect(screenButton('Kitchen TV')).toHaveTextContent('In use');
    expect(screenButton('Customer monitor')).toBeEnabled(); expect(externalButton()).toBeEnabled();
    // A closing customer window is not live: no Stop, no projection, and its screen stays reserved.
    state.active = true; state.displayId = 'hdmi-1'; state.token = issue(); state.phase = 'closing';
    fireEvent.click(screen.getByLabelText('Refresh')); await flush();
    expect(screen.queryByText('Stop External')).toBeNull(); expect(state.snapshot).toBeNull();
    expect(screenButton('Customer monitor')).toBeDisabled(); expect(screenButton('Customer monitor')).toHaveTextContent('In use');
    expect(externalButton()).toBeDisabled();
    // Once native destroyed the window the screen is offered again without a manual refresh.
    state.active = false; await tick(2000);
    expect(screenButton('Customer monitor')).toBeEnabled(); expect(externalButton()).toBeEnabled();
    expect(openCalls()).toEqual([]); expect(state.close).not.toHaveBeenCalled(); // the closing window was never adopted
  });

  it('a late open after sign-out and a replacement Stop closes only its own token, never the newer session', async () => {
    const first = render(<Harness />); await flush();
    // Native already processed the slow open (cd-token-1); its answer arrives after the owner signed out.
    let complete!: () => void;
    bridge.externalDisplay.open.mockImplementationOnce((params: any) => { const result = nativeOpen(params); return new Promise(done => { complete = () => done(result); }); });
    fireEvent.click(externalButton()); await flush();
    first.unmount(); await flush();
    expect(state.close).not.toHaveBeenCalled(); // nothing was owned yet
    // The replacement session adopts the running screen, stops it and opens its own presentation.
    render(<Harness />); await flush();
    fireEvent.click(screen.getByText('Stop External')); await flush();
    expect(closedTokens()).toEqual(['cd-token-1']);
    await open();
    expect(state.token).toBe('cd-token-2');
    await act(async () => complete()); await flush();
    // The late answer closed only its own, already ended token: the replacement keeps running.
    expect(closedTokens()).toEqual(['cd-token-1', 'cd-token-1']);
    expect(state.active).toBe(true); expect(state.token).toBe('cd-token-2'); expect(state.snapshot).not.toBeNull();
    fireEvent.click(screen.getByText('Stop External')); await flush();
    expect(closedTokens()).toEqual(['cd-token-1', 'cd-token-1', 'cd-token-2']); expect(state.active).toBe(false);
  });

  it('entitlement revocation and logout close only the owned token, never a newer presentation', async () => {
    const view = render(<Harness />); await flush(); await open();
    // A newer open rotated the native token, so this owner's cd-token-1 is stale.
    state.token = issue();
    state.enabled = false; view.rerender(<Harness />); await flush();
    expect(closedTokens()).toEqual(['cd-token-1']); expect(state.active).toBe(true); expect(state.snapshot).toBeNull();
    // Entitled again, the owner adopts the running presentation; logout closes exactly that token.
    state.enabled = true; view.rerender(<Harness />); await flush();
    expect(screen.getByText('Stop External')).toBeInTheDocument();
    state.identity = { ...state.identity, isReady: false }; view.rerender(<Harness />); await flush();
    expect(closedTokens()).toEqual(['cd-token-1', 'cd-token-2']); expect(state.active).toBe(false); expect(state.snapshot).toBeNull();
  });

  it('has no display API, pairing link, clipboard, TV URL or realtime path', () => {
    const source = readFileSync(resolve(__dirname, '..', 'CustomerDisplayPage.tsx'), 'utf8');
    expect(source).not.toMatch(/\/api\/|adminApi|fetchFromAdmin|clipboard|pairing|\/display\/customer|ADMIN_DASHBOARD_URL|kds_tickets|subscriptionManager/);
    expect(source).toMatch(/await bridge\.orders\.getAll\(\)/);
    // Every native close goes through the token owner; no content-wide close remains.
    expect(source).not.toMatch(/externalDisplay\.close\(/);
  });
});
