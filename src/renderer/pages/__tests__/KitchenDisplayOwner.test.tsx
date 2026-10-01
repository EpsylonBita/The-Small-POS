import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const identity = () => ({ branchId: 'branch', organizationId: 'org', terminalId: 'terminal', isResolving: false, isReady: true, missing: { branch: false, organization: false }, refresh: vi.fn() });
  return {
    initialIdentity: identity,
    identity: identity(),
    local: {
      orders: [] as unknown[],
      loadOrders: vi.fn(async () => {}),
      updateOrderStatus: vi.fn(async () => true),
      updateOrderStatusDetailed: vi.fn(async () => ({ success: true })),
    },
    listeners,
    subscribeLocal: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    storage: new Map<string, string>(),
    // Native lease table: connected screens and one presentation per content, each on its own screen.
    displays: [] as any[],
    presentations: [] as Array<{ contentType: string; displayId: string; token: string; state: 'opening' | 'active' | 'closing' }>,
    tokens: 0,
    issued: [] as string[],
    published: [] as unknown[],
    enabled: true,
    events: new Map<string, Set<() => void>>(),
    intent: undefined as any,
    snapshot: null as any,
    api: vi.fn(),
    fetch: vi.fn(),
    invoke: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
    patchLocal: vi.fn(),
    getLocal: vi.fn(async (_key: string): Promise<string | null> => null),
    setLocal: vi.fn(async (_update: any): Promise<any> => ({ success: true })),
    toastError: vi.fn(),
    t: (_key: string, fallback?: string) => fallback || _key,
  };
});
const KDS = 'kitchen_display';
const screenInfo = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, size: { width: 1920, height: 1080 }, isPrimary: false, hostsPos: false, external: true, ...extra });
const CASHIER = screenInfo('cashier', 'Cashier screen', { isPrimary: true, hostsPos: true, external: false });
const KITCHEN = screenInfo('kitchen', 'Kitchen monitor');
const occupant = (id: string) => state.presentations.find(entry => entry.displayId === id);
const kdsPresentation = () => state.presentations.find(entry => entry.contentType === KDS && entry.state !== 'closing');
function nativeCapabilities() {
  return {
    success: true, supported: true,
    displays: state.displays.map((display, index) => ({ ...display, index, available: display.external === true && !occupant(display.id), occupiedBy: occupant(display.id)?.contentType ?? null })),
    activePresentations: state.presentations.map(entry => ({ ...entry, label: `external-display-${entry.contentType}` })),
  };
}
// Mirrors the Rust lease table: an explicit screen is never redirected; reopening the running content rotates its token.
function nativeOpen({ contentType, displayId }: { contentType: string; displayId?: string }): any {
  const refuse = (code: string, occupiedBy: string | null = null) => ({ success: false, supported: true, code, error: `Native refused: ${code}`, contentType, label: `external-display-${contentType}`, occupiedBy });
  const running = state.presentations.find(entry => entry.contentType === contentType && entry.state !== 'closing');
  let target = displayId;
  if (target !== undefined) {
    const display = state.displays.find(entry => entry.id === target);
    if (!display) return refuse('display_not_found');
    if (display.isPrimary || display.hostsPos) return refuse('display_reserved_for_pos');
    const holder = occupant(target);
    if (holder && holder !== running) return refuse('display_occupied', holder.contentType);
    if (running && running.displayId !== target) return refuse('display_content_active', contentType);
  } else if (!running) {
    target = state.displays.find(entry => entry.external === true && !entry.isPrimary && !entry.hostsPos && entry.id && !occupant(entry.id))?.id;
    if (!target) return refuse('no_external_display');
  }
  const token = `${contentType}-token-${++state.tokens}`;
  state.issued.push(token);
  if (running) running.token = token;
  else state.presentations.push({ contentType, displayId: target!, token, state: 'active' });
  const shownOn = running?.displayId ?? target!;
  return { success: true, supported: true, contentType, label: `external-display-${contentType}`, token, displayId: shownOn, activeDisplayId: shownOn, reused: Boolean(running) };
}
// Only the current token closes; a stale token is a no-op.
function nativeClose({ contentType, token }: { contentType: string; token?: string }) {
  const running = state.presentations.find(entry => entry.contentType === contentType && entry.state !== 'closing');
  const closed = Boolean(running && token && running.token === token);
  if (closed) state.presentations = state.presentations.filter(entry => entry !== running);
  return { success: true, closed, stale: !closed, activePresentations: nativeCapabilities().activePresentations };
}
const bridge = {
  adminApi: { fetchFromAdmin: state.api }, invoke: state.invoke,
  settings: { getLocal: state.getLocal, set: state.setLocal },
  externalDisplay: {
    getCapabilities: vi.fn(async () => nativeCapabilities()),
    open: vi.fn(async (params: any): Promise<any> => nativeOpen(params)), close: state.close,
  },
};
vi.mock('../../../lib', () => ({
  getBridge: () => bridge,
  onEvent: (key: string, handler: () => void) => { if (!state.events.has(key)) state.events.set(key, new Set()); state.events.get(key)!.add(handler); },
  offEvent: (key: string, handler: () => void) => state.events.get(key)?.delete(handler),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('react-hot-toast', () => ({ toast: { error: state.toastError, success: vi.fn() }, default: { error: state.toastError, success: vi.fn() } }));
vi.mock('../../contexts/module-context', () => ({ useModules: () => ({ isModuleEnabled: () => state.enabled }) }));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('../../services/appAudio', () => ({ playAppAudioFile: vi.fn(), useAppAudioEnabled: vi.fn() }));
vi.mock('../../hooks/useResolvedPosIdentity', () => ({ useResolvedPosIdentity: () => state.identity }));
vi.mock('../../hooks/useOrderStore', async () => {
  const { useSyncExternalStore } = await import('react');
  const useOrderStore = (selector: (value: typeof state.local) => unknown) => useSyncExternalStore(state.subscribeLocal, () => selector(state.local));
  return { useOrderStore: Object.assign(useOrderStore, { setState: state.patchLocal, getState: () => state.local }) };
});
// Guards: any realtime channel or cloud client created by the KDS would be recorded here.
vi.mock('../../services/SubscriptionManager', () => ({ subscriptionManager: { subscribe: state.subscribe } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_name: string, handler: any) => { state.intent = handler; return () => { state.intent = undefined; }; }) }));
vi.mock('framer-motion', () => ({ motion: { div: ({ children, initial, animate, exit, ...props }: any) => <div {...props}>{children}</div> }, AnimatePresence: ({ children }: any) => children }));
import KitchenDisplayPage, { KitchenDisplayProvider } from '../KitchenDisplayPage';
import { clearAllKdsLocalDrafts, clearKdsLocalDraft, publishKdsLocalDraft } from '../../services/KdsLocalDraftStore';
import { localPreparationStore } from '../../services/KdsLocalPhaseStore';
import { LocalPreparationScopeSync } from '../../hooks/useLocalPreparation';
import { selectActiveKitchenStage } from '../../components/order/KitchenStageBadge';

const SCOPE = 'org|branch|terminal';
const PHASE_KEY = 'local.kds_phase_org_branch_terminal';
const order = (id: string, extra: Record<string, unknown> = {}) => ({
  id, status: 'pending', order_number: id.replace('order-', ''), order_type: 'pickup', terminal_id: 'terminal',
  created_at: new Date().toISOString(), items: [{ id: `${id}-item`, name: 'Soup', quantity: 1, station: 'hot' }], ...extra,
});
const storedMarks = (marks: Record<string, unknown>, v = 2) => JSON.stringify({ v, scope: SCOPE, marks });
// Previous release format (v1): still readable.
const storedPhase = (orderId: string, phase: string) => storedMarks({ [orderId]: { phase, at: new Date().toISOString() } }, 1);
const setLocalOrders = (orders: unknown[]) => act(() => { state.local.orders = orders; state.listeners.forEach(listener => listener()); });
const flush = () => act(async () => { for (let index = 0; index < 50; index++) await Promise.resolve(); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
// A connected-display intent names the scope and the owner session it was rendered from.
const intent = (payload: Record<string, unknown>) => act(() => { state.intent({ payload: { scope: SCOPE, session: state.snapshot?.sessionId, ...payload } }); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const cloudCalls = () => state.api.mock.calls.length + state.fetch.mock.calls.length + state.subscribe.mock.calls.length;
const nativeCommands = () => state.invoke.mock.calls.map(([command]) => String(command)).filter(command => !command.startsWith('kds-display-'));
// Mirrors App: the app-level scope sync selects the shared kitchen stage store scope.
function Harness({ page = true }: { page?: boolean }) { return <><LocalPreparationScopeSync /><KitchenDisplayProvider>{page ? <KitchenDisplayPage /> : <div>Order taking</div>}</KitchenDisplayProvider></>; }
async function openDisplay() { fireEvent.click(screen.getByLabelText('Open on connected display')); await flush(); }
async function showConnectedDisplay() { window.history.replaceState({}, '', '/?externalDisplay=kitchen_display'); const view = render(<KitchenDisplayPage />); await tick(500); return view; }

describe('persistent Windows KDS owner (strictly local)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', state.fetch);
    localPreparationStore.resetForTests();
    state.enabled = true; state.snapshot = null; state.events.clear(); state.intent = undefined;
    state.displays = [CASHIER, KITCHEN]; state.presentations = []; state.tokens = 0; state.issued = []; state.published = [];
    state.identity = state.initialIdentity();
    state.local.orders = [];
    state.storage.clear();
    [state.local.loadOrders, state.local.updateOrderStatus, state.local.updateOrderStatusDetailed, state.patchLocal, state.toastError].forEach(mock => mock.mockClear());
    [state.api, state.fetch, state.subscribe].forEach(mock => mock.mockReset());
    state.getLocal.mockReset().mockImplementation(async key => state.storage.get(key) ?? null);
    state.setLocal.mockReset().mockImplementation(async ({ category, key, value }) => { state.storage.set(`${category}.${key}`, value); return { success: true }; });
    bridge.externalDisplay.getCapabilities.mockReset().mockImplementation(async () => nativeCapabilities());
    bridge.externalDisplay.open.mockReset().mockImplementation(async (params: any) => nativeOpen(params));
    state.close.mockReset().mockImplementation(async (params: any) => nativeClose(params));
    state.invoke.mockReset().mockImplementation(async (command, payload) => {
      if (command === 'kds-display-publish') { state.snapshot = payload; state.published.push(payload); }
      if (command === 'kds-display-snapshot') return state.snapshot;
      if (command === 'kds-display-intent') state.intent?.({ payload });
    });
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => {
    try {
      // Every scenario: no KDS API, fetch or realtime channel, no native order command, no order status write.
      expect(cloudCalls()).toBe(0);
      expect(nativeCommands()).toEqual([]);
      expect(state.local.updateOrderStatus).not.toHaveBeenCalled();
      expect(state.local.updateOrderStatusDetailed).not.toHaveBeenCalled();
      expect(state.patchLocal).not.toHaveBeenCalled();
      // Every native close names the one presentation it may close: never the content alone.
      expect(state.close.mock.calls.filter(([params]) => typeof params?.token !== 'string' || !params.token)).toEqual([]);
      // A presentation token never leaves the main window.
      expect(state.published.filter(payload => /"token"/.test(JSON.stringify(payload ?? null)) || state.issued.some(token => JSON.stringify(payload ?? null).includes(token)))).toEqual([]);
    } finally {
      cleanup(); clearAllKdsLocalDrafts(); localPreparationStore.resetForTests(); vi.unstubAllGlobals(); vi.useRealTimers();
    }
  });

  it('one local owner read serves the page, the connected display and navigation', async () => {
    state.local.orders = [order('order-1')];
    const mounted = render(<Harness />); await flush();
    // App-level stage hydration plus one owner read (stages + local order store), all local IPC.
    const reads = state.getLocal.mock.calls.length;
    expect(reads).toBe(2);
    expect(state.local.loadOrders).toHaveBeenCalledTimes(1);
    await openDisplay();
    mounted.rerender(<Harness page={false} />); await flush();
    expect(state.getLocal).toHaveBeenCalledTimes(reads);
    expect(state.local.loadOrders).toHaveBeenCalledTimes(1);
    expect(state.snapshot.orders).toHaveLength(1);
    ['order-created', 'order-status-updated', 'order-deleted', 'online'].forEach(key => state.events.get(key)?.forEach(handler => handler()));
    await tick(8000);
    expect(state.getLocal).toHaveBeenCalledTimes(reads);
    expect(state.local.loadOrders).toHaveBeenCalledTimes(1);
    state.presentations = []; await tick(2000); // local monitor closure detection
    expect(state.snapshot).toBeNull();
  });

  it('keeps projecting new local orders after the page unmounts while the cloud is unavailable', async () => {
    state.api.mockRejectedValue(new Error('offline')); state.fetch.mockRejectedValue(new Error('offline'));
    state.local.orders = [order('order-1')];
    const mounted = render(<Harness />); await flush();
    const reads = state.getLocal.mock.calls.length;
    await openDisplay();
    mounted.rerender(<Harness page={false} />); await flush();
    await showConnectedDisplay();
    expect(screen.getAllByText('Soup')).toHaveLength(1);
    setLocalOrders([order('order-1'), order('order-2', { table_number: 'T4', notes: 'No salt', items: [{ id: 'burger', name: 'Burger', quantity: 2, station: 'grill', notes: 'Well done', customizations: [{ name: 'Cheese' }, { option: { name: 'Bacon' }, quantity: 2 }] }] })]);
    await tick(500);
    ['Burger', 'T4', 'No salt', 'Well done', 'Cheese, Bacon x2'].forEach(text => expect(screen.getByText(text)).toBeInTheDocument());
    setLocalOrders([order('order-1'), order('order-2', { table_number: 'T5', notes: 'Extra napkins', items: [{ id: 'burger', name: 'Burger', quantity: 2, station: 'grill', modifiers: ['Onion'] }] })]);
    await tick(500);
    ['T5', 'Extra napkins', 'Onion'].forEach(text => expect(screen.getByText(text)).toBeInTheDocument());
    ['No salt', 'Well done', 'Cheese, Bacon x2'].forEach(text => expect(screen.queryByText(text)).not.toBeInTheDocument());
    expect(state.snapshot.orders.map((entry: any) => entry.order_number)).toEqual(['1', '2']);
    await tick(30_000); // receiver frames and local monitor checks only
    expect(state.getLocal).toHaveBeenCalledTimes(reads);
    expect(state.local.loadOrders).toHaveBeenCalledTimes(1);
  });

  it('a paused page keeps the connected display live; a DB-only rehydration after sync is throttled', async () => {
    state.local.orders = [order('order-1')];
    const mounted = render(<Harness />); await flush();
    await openDisplay();
    intent({ action: 'auto', value: false }); await flush();
    mounted.rerender(<Harness page={false} />); await flush();
    setLocalOrders([order('order-1'), order('order-2')]); await flush();
    expect(state.snapshot).toMatchObject({ autoRefresh: false, isLive: false });
    expect(state.snapshot.orders.map((entry: any) => entry.id)).toEqual(['order-1', 'order-2']);
    // Paused and off-page, but the display is active: sync re-reads SQLite at most every 30 s.
    const reads = state.getLocal.mock.calls.length;
    const loads = state.local.loadOrders.mock.calls.length;
    const syncComplete = () => act(() => { state.events.get('sync:complete')?.forEach(handler => handler()); });
    syncComplete(); await flush();
    expect(state.getLocal).toHaveBeenCalledTimes(reads);
    await tick(30_000);
    syncComplete(); await flush();
    expect(state.getLocal).toHaveBeenCalledTimes(reads + 1);
    expect(state.local.loadOrders).toHaveBeenCalledTimes(loads + 1);
    intent({ action: 'auto', value: true }); await flush();
    expect(state.snapshot).toMatchObject({ autoRefresh: true, isLive: true });
  });

  it('persists local preparing, ready and collected across restart per scope without touching order status', async () => {
    state.local.orders = [order('order-1')];
    let view = render(<Harness />); await flush();
    fireEvent.click(screen.getByText('Start Preparing')); await flush();
    expect(screen.getByText('Mark Ready')).toBeInTheDocument();
    expect(JSON.parse(state.storage.get(PHASE_KEY)!)).toEqual({ v: 2, scope: SCOPE, marks: { 'order-1': { phase: 'preparing', at: expect.any(String) } } });
    view.unmount(); await flush();
    view = render(<Harness />); await flush(); // restart: the app-level store restores the stored stage
    fireEvent.click(screen.getByText('Mark Ready')); await flush();
    expect(screen.getByText('Soup')).toBeInTheDocument(); // ready stays on the board until it is collected
    fireEvent.click(screen.getByText('Mark Collected')); await flush();
    expect(screen.queryByText('Soup')).not.toBeInTheDocument();
    view.unmount(); await flush();
    view = render(<Harness />); await flush();
    expect(screen.queryByText('Soup')).not.toBeInTheDocument(); // a collected ticket never comes back
    state.identity = { ...state.identity, organizationId: 'org-2' };
    view.rerender(<Harness />); await flush();
    expect(screen.getByText('Start Preparing')).toBeInTheDocument(); // another scope keeps its own stages
    expect(state.setLocal.mock.calls.map(([update]) => `${update.category}.${update.key}`)).toEqual([PHASE_KEY, PHASE_KEY, PHASE_KEY]);
    expect(JSON.parse(state.storage.get(PHASE_KEY)!).marks).toEqual({ 'order-1': { phase: 'collected', at: expect.any(String) } });
    expect(state.local.orders).toEqual([expect.objectContaining({ id: 'order-1', status: 'pending' })]);
  });

  it('a canonical ready order stays until collected; closed, financial, ghost, Z, repair and foreign orders never show', async () => {
    state.storage.set(PHASE_KEY, storedPhase('order-8', 'collected'));
    state.local.orders = [
      order('order-1', { status: 'ready', payment_status: 'unpaid' }),
      order('order-2', { status: 'completed' }),
      order('order-3', { status: 'ready', is_closed: 1 }),
      order('order-4', { status: 'refunded' }),
      order('order-5', { status: 'ready', is_ghost: true }),
      order('order-6', { status: 'ready', z_report_id: 'z-1' }),
      order('order-7', { status: 'ready', terminal_id: 'other-terminal' }),
      order('order-8', { status: 'ready' }),
      order('order-9', { status: 'ready', organization_id: 'org-2' }),
      order('order-10', { status: 'ready', order_context: 'repair_settlement' }),
    ];
    render(<Harness />); await flush();
    await openDisplay();
    expect(state.snapshot.orders.map((entry: any) => `${entry.id}:${entry.status}`)).toEqual(['order-1:ready']);
    expect(screen.getByText('Mark Collected')).toBeInTheDocument();
    intent({ action: 'bump', value: 'order-1', status: 'ready' }); await flush();
    expect(state.snapshot.orders).toEqual([]);
    expect(screen.queryByText('Soup')).not.toBeInTheDocument();
    const stored = JSON.parse(state.storage.get(PHASE_KEY)!);
    expect(stored).toMatchObject({ v: 2, scope: SCOPE });
    expect(Object.keys(stored.marks).sort()).toEqual(['order-1', 'order-8']); // older marks are never evicted
    expect(stored.marks['order-1']).toEqual({ phase: 'collected', at: expect.any(String) });
    // The unpaid sale stays an active canonical order: only its local kitchen stage changed.
    expect(state.local.orders[0]).toEqual(expect.objectContaining({ id: 'order-1', status: 'ready', payment_status: 'unpaid' }));
  });

  it('connected-display intents move the shared local stage that the central order views read', async () => {
    state.local.orders = [order('order-1', { payment_status: 'unpaid' })];
    render(<Harness />); await flush();
    await openDisplay();
    const centralStage = () => selectActiveKitchenStage(localPreparationStore.getSnapshot(), state.local.orders[0]);
    expect(centralStage()).toBeUndefined();
    intent({ action: 'bump', value: 'order-1', status: 'pending' }); await flush();
    expect(state.snapshot.orders[0].status).toBe('preparing'); expect(centralStage()).toBe('preparing');
    intent({ action: 'bump', value: 'order-1', status: 'preparing' }); await flush();
    expect(state.snapshot.orders[0].status).toBe('ready'); expect(centralStage()).toBe('ready');
    intent({ action: 'bump', value: 'order-1', status: 'ready' }); await flush();
    expect(state.snapshot.orders).toEqual([]); expect(centralStage()).toBe('collected');
    expect(state.local.orders).toEqual([expect.objectContaining({ id: 'order-1', status: 'pending', payment_status: 'unpaid' })]);
  });

  it('collects an order marked under its local id after it reappears under its cloud id', async () => {
    state.storage.set(PHASE_KEY, storedMarks({ 'local-1': { phase: 'ready', at: new Date().toISOString(), refs: ['client-1'] } }));
    state.local.orders = [order('cloud-1', { client_order_id: 'client-1' })];
    let view = render(<Harness />); await flush();
    fireEvent.click(screen.getByText('Mark Collected')); await flush();
    expect(screen.queryByText('Soup')).not.toBeInTheDocument();
    expect(state.toastError).not.toHaveBeenCalled();
    expect(state.setLocal).toHaveBeenCalledTimes(1);
    // One folded forward mark under the current id keeps every alias.
    expect(JSON.parse(state.storage.get(PHASE_KEY)!).marks).toEqual({
      'cloud-1': { phase: 'collected', at: expect.any(String), refs: expect.arrayContaining(['client-1', 'local-1']) },
    });
    view.unmount(); await flush();
    view = render(<Harness />); await flush();
    expect(screen.queryByText('Soup')).not.toBeInTheDocument();
  });

  it.each(['logout', 'rebind'])('a local read still pending at %s fails closed and never publishes', async action => {
    state.local.orders = [order('order-1')];
    state.storage.set(PHASE_KEY, storedPhase('order-1', 'preparing'));
    const pending = deferred<string | null>();
    state.getLocal.mockImplementationOnce(() => pending.promise);
    const mounted = render(<Harness />); await flush();
    await openDisplay();
    expect(screen.queryByText('Soup')).not.toBeInTheDocument(); // an unread stage is never shown as pending
    expect(state.snapshot.orders).toEqual([]);
    state.identity = action === 'logout' ? { ...state.identity, isReady: false } : { ...state.identity, organizationId: 'org-2' };
    mounted.rerender(<Harness />); await flush();
    await act(async () => pending.resolve(state.storage.get(PHASE_KEY)!)); await flush();
    expect(state.snapshot).toBeNull();
    expect(screen.queryByText('Mark Ready')).not.toBeInTheDocument();
    if (action === 'logout') expect(screen.queryByText('Soup')).not.toBeInTheDocument();
    else expect(screen.getByText('Start Preparing')).toBeInTheDocument();
    expect(state.setLocal).not.toHaveBeenCalled();
  });

  it('unreadable storage fails closed; a later read failure keeps the last good board and storage is never overwritten', async () => {
    state.local.orders = [order('order-1')];
    state.storage.set(PHASE_KEY, '{broken');
    render(<Harness />); await flush();
    await openDisplay();
    expect(state.snapshot).toMatchObject({ error: 'Unable to load orders', orders: [] });
    expect(screen.queryByText('Start Preparing')).not.toBeInTheDocument();
    state.storage.delete(PHASE_KEY);
    intent({ action: 'refresh' }); await flush();
    expect(state.snapshot).toMatchObject({ error: null, stale: false });
    expect(screen.getByText('Start Preparing')).toBeInTheDocument();
    state.getLocal.mockRejectedValueOnce(new Error('database locked'));
    intent({ action: 'refresh' }); await flush();
    // Same scope: the last good board stays, flagged stale, never an empty or reset board.
    expect(state.snapshot).toMatchObject({ error: null, stale: true });
    expect(state.snapshot.orders.map((entry: any) => entry.id)).toEqual(['order-1']);
    expect(screen.getByText('Start Preparing')).toBeInTheDocument();
    // A bump re-reads storage first: malformed storage is reported, never overwritten.
    state.storage.set(PHASE_KEY, '{broken');
    intent({ action: 'bump', value: 'order-1', status: 'pending' }); await flush();
    expect(state.setLocal).not.toHaveBeenCalled();
    expect(state.storage.get(PHASE_KEY)).toBe('{broken');
    expect(state.toastError).toHaveBeenCalledWith('Failed to update order');
  });

  it('rejects duplicate bumps while one is saving and keeps the order when saving fails', async () => {
    state.local.orders = [order('order-1')];
    render(<Harness />); await flush();
    await openDisplay();
    const saving = deferred<{ success: boolean }>();
    state.setLocal.mockImplementationOnce(() => saving.promise);
    act(() => {
      const payload = { scope: SCOPE, session: state.snapshot.sessionId, action: 'bump', value: 'order-1', status: 'pending' };
      state.intent({ payload });
      state.intent({ payload });
    });
    fireEvent.click(screen.getByText('Start Preparing')); await flush();
    expect(state.setLocal).toHaveBeenCalledTimes(1);
    await act(async () => saving.resolve({ success: false })); await flush();
    expect(state.toastError).toHaveBeenCalledWith('Failed to update order');
    expect(screen.getByText('Start Preparing')).toBeInTheDocument();
    expect(state.storage.has(PHASE_KEY)).toBe(false);
    intent({ action: 'bump', value: 'order-1', status: 'pending' }); await flush();
    expect(screen.getByText('Mark Ready')).toBeInTheDocument();
    intent({ action: 'bump', value: 'order-1', status: 'pending' }); await flush(); // a delayed old snapshot never skips to ready
    expect(state.setLocal).toHaveBeenCalledTimes(2);
    expect(JSON.parse(state.storage.get(PHASE_KEY)!).marks['order-1'].phase).toBe('preparing');
  });

  it('coalesces local refresh bursts into one running and one queued read', async () => {
    render(<Harness />); await flush();
    await openDisplay();
    const reads = state.getLocal.mock.calls.length;
    const loads = state.local.loadOrders.mock.calls.length;
    const pending = deferred<string | null>();
    state.getLocal.mockImplementationOnce(() => pending.promise);
    act(() => { for (let index = 0; index < 10; index++) state.intent({ payload: { scope: SCOPE, session: state.snapshot.sessionId, action: 'refresh' } }); }); await flush();
    expect(state.getLocal).toHaveBeenCalledTimes(reads + 1);
    expect(state.local.loadOrders).toHaveBeenCalledTimes(loads + 1);
    await act(async () => pending.resolve(null)); await flush();
    expect(state.getLocal).toHaveBeenCalledTimes(reads + 2);
    expect(state.local.loadOrders).toHaveBeenCalledTimes(loads + 2);
  });

  it('projects scoped local cart drafts as display-only cards', async () => {
    render(<Harness />); await flush();
    await openDisplay();
    act(() => {
      publishKdsLocalDraft({ scope: SCOPE, sessionId: 'session-1', orderType: 'pickup', updatedAt: new Date().toISOString(), items: [{ id: 'd1', name: 'Draft soup', quantity: 1, station: 'hot', modifiers: ['Chili'] }] });
      publishKdsLocalDraft({ scope: 'org|branch|other-terminal', sessionId: 'session-2', orderType: 'pickup', updatedAt: new Date().toISOString(), items: [{ id: 'd2', name: 'Foreign draft', quantity: 1, station: 'hot' }] });
    }); await flush();
    expect(screen.getByText('Draft soup')).toBeInTheDocument();
    expect(screen.getByText('Chili')).toBeInTheDocument();
    expect(screen.queryByText('Foreign draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Start Preparing')).not.toBeInTheDocument();
    intent({ action: 'bump', value: 'live-draft-session-1', status: 'pending' }); await flush();
    expect(state.setLocal).not.toHaveBeenCalled();
    expect(state.snapshot.orders).toEqual([expect.objectContaining({ id: 'live-draft-session-1', isDraft: true })]);
    act(() => clearKdsLocalDraft(SCOPE, 'session-1')); await flush();
    expect(screen.queryByText('Draft soup')).not.toBeInTheDocument();
    expect(state.snapshot.orders).toEqual([]);
  });

  it('the connected-display window is a read-only receiver of the native snapshot', async () => {
    state.snapshot = {
      identityScope: SCOPE, sessionId: 'owner-session', loading: false, stations: [], stationFilter: 'all', viewMode: 'grid', soundEnabled: true, autoRefresh: true, error: null, stale: false, isLive: true,
      isIdentityResolving: false, isIdentityReady: true, missing: { branch: false, organization: false }, activeExternalDisplay: true,
      orders: [{ id: 'order-1', order_number: '1', order_type: 'pickup', status: 'pending', created_at: new Date().toISOString(), priority: 'normal', source: 'local-order', isDraft: false, items: [{ id: 'item', name: 'Soup', quantity: 1, station: 'hot', status: 'pending' }] }],
    };
    window.history.replaceState({}, '', '/?externalDisplay=kitchen_display');
    render(<KitchenDisplayPage />); await flush();
    fireEvent.click(screen.getByText('Start Preparing')); await flush();
    expect(state.invoke).toHaveBeenCalledWith('kds-display-intent', { scope: SCOPE, session: 'owner-session', action: 'bump', value: 'order-1', status: 'pending' });
    await tick(5000);
    expect(state.invoke.mock.calls.filter(([command]) => command === 'kds-display-snapshot').length).toBeGreaterThanOrEqual(10);
    expect(state.getLocal).not.toHaveBeenCalled();
    expect(state.setLocal).not.toHaveBeenCalled();
    expect(state.local.loadOrders).not.toHaveBeenCalled();
  });

  it('stopping projection and leaving the page releases the owner; remount starts one new local read', async () => {
    const mounted = render(<Harness />); await flush();
    await openDisplay();
    fireEvent.click(screen.getByLabelText('Stop external display')); await flush();
    mounted.rerender(<Harness page={false} />); await flush();
    expect(state.snapshot).toBeNull();
    const reads = state.getLocal.mock.calls.length;
    const loads = state.local.loadOrders.mock.calls.length;
    await tick(12000);
    expect(state.getLocal).toHaveBeenCalledTimes(reads);
    mounted.rerender(<Harness />); await flush();
    expect(state.getLocal).toHaveBeenCalledTimes(reads + 1);
    expect(state.local.loadOrders).toHaveBeenCalledTimes(loads + 1);
  });

  it('rejects display intents from another owner session or an old scope', async () => {
    state.local.orders = [order('order-1')];
    const mounted = render(<Harness />); await flush();
    await openDisplay();
    const staleIntent = state.intent;
    const session = state.snapshot.sessionId;
    expect(session).toEqual(expect.any(String));
    intent({ action: 'bump', value: 'order-1', status: 'pending', session: 'other-session' }); await flush();
    intent({ action: 'bump', value: 'order-1', status: 'pending', session: undefined }); await flush();
    expect(state.setLocal).not.toHaveBeenCalled();
    expect(screen.getByText('Start Preparing')).toBeInTheDocument();
    state.identity = { ...state.identity, organizationId: 'org-2' };
    mounted.rerender(<Harness />); await flush();
    expect(state.snapshot).toBeNull();
    act(() => staleIntent({ payload: { scope: SCOPE, session, action: 'bump', value: 'order-1', status: 'pending' } })); await flush();
    expect(state.setLocal).not.toHaveBeenCalled();
  });

  it('module revocation clears projected data and releases the owner', async () => {
    state.local.orders = [order('order-1')];
    const mounted = render(<Harness />); await flush();
    await openDisplay();
    expect(state.snapshot.orders).toHaveLength(1);
    state.enabled = false; mounted.rerender(<Harness page={false} />); await flush();
    expect(state.snapshot).toBeNull(); expect(kdsPresentation()).toBeUndefined();
    const reads = state.getLocal.mock.calls.length; await tick(16000);
    expect(state.getLocal).toHaveBeenCalledTimes(reads);
  });

  it.each(['rebind', 'logout', 'revoke'])('late native open after %s cannot resurrect projection', async action => {
    const mounted = render(<Harness />); await flush();
    let complete!: () => void;
    bridge.externalDisplay.open.mockImplementationOnce((params: any) => new Promise(resolve => { complete = () => resolve(nativeOpen(params)); }));
    fireEvent.click(screen.getByLabelText('Open on connected display')); await flush();
    if (action === 'logout') mounted.unmount();
    else {
      if (action === 'rebind') state.identity = { ...state.identity, terminalId: 'other-terminal' };
      else state.enabled = false;
      mounted.rerender(<Harness page={false} />);
    }
    await flush(); await act(async () => complete()); await flush();
    expect(kdsPresentation()).toBeUndefined(); expect(state.snapshot).toBeNull();
    // The late completion closed exactly the window it created.
    expect(state.close.mock.calls).toEqual([[{ contentType: KDS, token: state.issued[0] }]]);
  });

  it('the header opens Auto without a screen id and Stop closes exactly the owned token', async () => {
    render(<Harness />); await flush();
    await openDisplay();
    expect(bridge.externalDisplay.open.mock.calls).toEqual([[{ contentType: KDS }]]);
    const owned = kdsPresentation()!.token;
    expect(kdsPresentation()).toMatchObject({ displayId: 'kitchen' });
    expect(screen.getByText('Running here')).toBeInTheDocument();
    expect(screen.queryByText('Cashier screen')).not.toBeInTheDocument(); // the POS monitor is never offered
    fireEvent.click(screen.getByLabelText('Stop external display')); await flush();
    expect(state.close.mock.calls).toEqual([[{ contentType: KDS, token: owned }]]);
    expect(kdsPresentation()).toBeUndefined();
    // The freed screen is offered again once the native side reports it free.
    expect(screen.getByLabelText('Open on connected display')).toBeEnabled();
    expect(screen.getByRole('button', { name: /Kitchen monitor/ })).toBeEnabled();
  });

  it('a chosen screen travels only as its opaque id', async () => {
    state.displays = [CASHIER, screenInfo('screen-b', 'Screen B'), screenInfo('screen-c', 'Screen C')];
    render(<Harness />); await flush();
    fireEvent.click(screen.getByRole('button', { name: /Screen C/ })); await flush();
    expect(bridge.externalDisplay.open.mock.calls).toEqual([[{ contentType: KDS, displayId: 'screen-c' }]]);
    expect(kdsPresentation()).toMatchObject({ displayId: 'screen-c' });
    expect(screen.getByText('Running here')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Screen B/ })).toBeEnabled();
  });

  it.each(['display_occupied', 'display_not_found'])('a stale screen choice refused with %s shows the error and is never redirected', async code => {
    state.displays = [CASHIER, screenInfo('screen-b', 'Screen B'), screenInfo('screen-c', 'Screen C')];
    render(<Harness />); await flush();
    // The capability list still says Screen C is free; natively it changed since.
    if (code === 'display_occupied') state.presentations.push({ contentType: 'customer_display', displayId: 'screen-c', token: 'cd-1', state: 'active' });
    else state.displays = state.displays.filter(display => display.id !== 'screen-c');
    fireEvent.click(screen.getByRole('button', { name: /Screen C/ })); await flush();
    expect(screen.getByText(`Native refused: ${code}`)).toBeInTheDocument();
    await tick(10_000);
    // One open with only the chosen id: no retry on Screen B and no Auto fallback.
    expect(bridge.externalDisplay.open.mock.calls).toEqual([[{ contentType: KDS, displayId: 'screen-c' }]]);
    expect(kdsPresentation()).toBeUndefined();
    expect(state.close).not.toHaveBeenCalled();
    expect(state.snapshot).toBeNull();
    if (code === 'display_occupied') expect(screen.getByRole('button', { name: /Screen C/ })).toBeDisabled();
    else expect(screen.queryByText('Screen C')).not.toBeInTheDocument();
  });

  it('offers only explicit external screens; another content or a closing window blocks its screen without counting as live', async () => {
    state.displays = [
      CASHIER,
      screenInfo('screen-b', 'Customer screen'),
      screenInfo('screen-c', 'Closing screen'),
      screenInfo('screen-d', 'Free screen'),
      screenInfo('screen-e', 'Unknown topology', { external: undefined }),
      screenInfo('', 'Anonymous screen'),
    ];
    state.presentations = [
      { contentType: 'customer_display', displayId: 'screen-b', token: 'cd-1', state: 'active' },
      { contentType: KDS, displayId: 'screen-c', token: 'kds-closing', state: 'closing' },
    ];
    render(<Harness />); await flush();
    expect(screen.getByRole('button', { name: /Customer screen/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Closing screen/ })).toBeDisabled();
    expect(screen.getAllByText('In use')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Free screen/ })).toBeEnabled();
    ['Cashier screen', 'Unknown topology', 'Anonymous screen'].forEach(name => expect(screen.queryByText(name)).not.toBeInTheDocument());
    // A closing window is not live: no Stop, no projection, and its token is never adopted.
    expect(screen.queryByLabelText('Stop external display')).not.toBeInTheDocument();
    expect(state.snapshot).toBeNull();
    await openDisplay();
    expect(bridge.externalDisplay.open.mock.calls).toEqual([[{ contentType: KDS }]]);
    const owned = kdsPresentation()!.token;
    expect(kdsPresentation()).toMatchObject({ displayId: 'screen-d' });
    fireEvent.click(screen.getByLabelText('Stop external display')); await flush();
    expect(state.close.mock.calls).toEqual([[{ contentType: KDS, token: owned }]]);
    expect(state.presentations.map(entry => entry.token)).toEqual(['cd-1', 'kds-closing']);
  });

  it('with no valid external screen the open action is disabled and the help text shows', async () => {
    state.displays = [CASHIER, screenInfo('screen-e', 'Unknown topology', { external: undefined })];
    render(<Harness />); await flush();
    expect(screen.getByLabelText('Open on connected display')).toBeDisabled();
    expect(screen.getByText('Connect an HDMI display or an OS-level wireless display, then select it here.')).toBeInTheDocument();
    expect(screen.queryByText('Unknown topology')).not.toBeInTheDocument();
  });

  it('a late open after a scope change closes only its own token; the replacement keeps its newer one', async () => {
    const mounted = render(<Harness />); await flush();
    let late!: { params: any; resolve: (value: unknown) => void };
    bridge.externalDisplay.open.mockImplementationOnce((params: any) => new Promise(resolve => { late = { params, resolve }; }));
    await openDisplay();
    state.identity = { ...state.identity, terminalId: 'other-terminal' };
    mounted.rerender(<Harness />); await flush();
    // The native side handles the old open, then the replacement session reopens: the token rotates.
    const lateResult = nativeOpen(late.params);
    await openDisplay();
    const replacement = kdsPresentation()!.token;
    expect(replacement).not.toBe(lateResult.token);
    await act(async () => late.resolve(lateResult)); await flush();
    expect(state.close.mock.calls).toEqual([[{ contentType: KDS, token: lateResult.token }]]);
    expect(kdsPresentation()).toMatchObject({ token: replacement });
    await tick(2000);
    expect(screen.getByLabelText('Stop external display')).toBeInTheDocument();
    expect(state.snapshot).toMatchObject({ identityScope: 'org|branch|other-terminal' });
    fireEvent.click(screen.getByLabelText('Stop external display')); await flush();
    expect(state.close.mock.calls).toEqual([[{ contentType: KDS, token: lateResult.token }], [{ contentType: KDS, token: replacement }]]);
    expect(kdsPresentation()).toBeUndefined();
  });

  it('a Stop while an older open is still answering closes nothing it does not own; the late answer closes only its token', async () => {
    const mounted = render(<Harness />); await flush();
    let respond!: () => void;
    // The native side opens at once; its answer reaches this renderer late.
    bridge.externalDisplay.open.mockImplementationOnce((params: any) => { const result = nativeOpen(params); return new Promise(resolve => { respond = () => resolve(result); }); });
    await openDisplay();
    const lateToken = kdsPresentation()!.token;
    state.identity = { ...state.identity, terminalId: 'other-terminal' };
    mounted.rerender(<Harness />); await flush();
    // The new session sees the window but never adopts a presentation an open in flight will answer for.
    fireEvent.click(screen.getByLabelText('Stop external display')); await flush();
    expect(state.close).not.toHaveBeenCalled();
    await act(async () => respond()); await flush();
    expect(state.close.mock.calls).toEqual([[{ contentType: KDS, token: lateToken }]]);
    expect(kdsPresentation()).toBeUndefined();
    await tick(2000);
    await openDisplay();
    const replacement = kdsPresentation()!.token;
    fireEvent.click(screen.getByLabelText('Stop external display')); await flush();
    expect(state.close.mock.calls).toEqual([[{ contentType: KDS, token: lateToken }], [{ contentType: KDS, token: replacement }]]);
  });

  it.each(['revoke', 'logout', 'unmount'])('%s closes only the owned kitchen token', async action => {
    state.displays = [CASHIER, KITCHEN, screenInfo('customer', 'Customer screen')];
    state.presentations = [{ contentType: 'customer_display', displayId: 'customer', token: 'cd-1', state: 'active' }];
    const mounted = render(<Harness />); await flush();
    await openDisplay();
    const owned = kdsPresentation()!.token;
    if (action === 'unmount') mounted.unmount();
    else {
      if (action === 'revoke') state.enabled = false;
      else state.identity = { ...state.identity, isReady: false };
      mounted.rerender(<Harness page={false} />);
    }
    await flush();
    expect(state.close.mock.calls).toEqual([[{ contentType: KDS, token: owned }]]);
    expect(state.presentations).toEqual([expect.objectContaining({ contentType: 'customer_display', token: 'cd-1' })]);
    expect(state.snapshot).toBeNull();
  });

  it('publishes board data only: an adopted or opened presentation token never reaches the connected display', async () => {
    state.local.orders = [order('order-1')];
    state.presentations = [{ contentType: KDS, displayId: 'kitchen', token: 'kds-before-reload', state: 'active' }];
    state.issued.push('kds-before-reload');
    render(<Harness />); await flush();
    // A window left running by a reloaded main window is adopted and projects the board.
    expect(state.snapshot.orders.map((entry: any) => entry.id)).toEqual(['order-1']);
    fireEvent.click(screen.getByLabelText('Stop external display')); await flush();
    expect(state.close.mock.calls).toEqual([[{ contentType: KDS, token: 'kds-before-reload' }]]);
    await openDisplay();
    expect(state.snapshot.orders.map((entry: any) => entry.id)).toEqual(['order-1']);
    const snapshots = state.published.filter(Boolean) as any[];
    expect(snapshots.length).toBeGreaterThan(0);
    snapshots.forEach(snapshot => {
      expect(snapshot).not.toHaveProperty('displayCapabilities');
      expect(snapshot).not.toHaveProperty('externalDisplays');
      state.issued.forEach(token => expect(JSON.stringify(snapshot)).not.toContain(token));
    });
  });
});
