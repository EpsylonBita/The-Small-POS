import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { identity, apiHelpers } = vi.hoisted(() => ({
  identity: {
    current: {
      organizationId: 'org-1' as string | null,
      branchId: 'branch-1' as string | null,
      terminalId: 'terminal-1' as string | null,
      isReady: true,
    },
  },
  // The hook's former cloud transport. Local drafts must never touch it.
  apiHelpers: {
    posApiFetch: vi.fn(),
    posApiGet: vi.fn(),
    posApiPost: vi.fn(),
    posApiPut: vi.fn(),
    posApiPatch: vi.fn(),
    posApiDelete: vi.fn(),
  },
}));

vi.mock('../useResolvedPosIdentity', () => ({
  useResolvedPosIdentity: () => identity.current,
}));
vi.mock('../../utils/api-helpers', () => apiHelpers);

import {
  clearAllKdsLocalDrafts,
  getKdsLocalDrafts,
  subscribeKdsLocalDrafts,
} from '../../services/KdsLocalDraftStore';
import { useKdsLiveDraftSync } from '../useKdsLiveDraftSync';

type HookProps = Parameters<typeof useKdsLiveDraftSync>[0];

const READY_IDENTITY = {
  organizationId: 'org-1',
  branchId: 'branch-1',
  terminalId: 'terminal-1',
  isReady: true,
};
const SCOPE = 'org-1|branch-1|terminal-1';
const pizza = { id: 'line-1', name: 'Margherita', quantity: 1 };
const cola = { id: 'line-2', name: 'Cola', quantity: 1 };

let fetchSpy: ReturnType<typeof vi.fn>;
const unsubscribers: Array<() => void> = [];

function renderDraftHook(overrides: Partial<HookProps> = {}) {
  let props: HookProps = {
    enabled: true,
    isOpen: true,
    orderType: 'dine_in',
    cartItems: [pizza],
    ...overrides,
  };
  const view = renderHook((current: HookProps) => useKdsLiveDraftSync(current), {
    initialProps: props,
  });
  const update = (patch: Partial<HookProps> = {}) => {
    props = { ...props, ...patch };
    view.rerender(props);
  };
  return { ...view, update };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const draftScopes = () => getKdsLocalDrafts().map((draft) => draft.scope);

describe('useKdsLiveDraftSync (local-only KDS drafts)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    identity.current = { ...READY_IDENTITY };
    clearAllKdsLocalDrafts();
  });

  afterEach(() => {
    cleanup();
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    const fetchCalls = fetchSpy.mock.calls.length;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearAllKdsLocalDrafts();
    // Strictly local in every scenario, including unmount: no fetch, no POS API.
    expect(fetchCalls).toBe(0);
    for (const spy of Object.values(apiHelpers)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('publishes the open cart after 400 ms with scope, items and modifiers but no customer or price data', () => {
    const detailedLine = {
      id: 'line-1',
      name: '  Margherita  ',
      quantity: 2,
      notes: '  well done  ',
      customizations: [{ name: 'Extra cheese' }, 'No onion'],
      // Cart fields that must never reach the kitchen draft.
      price: 9.5,
      unitPrice: 9.5,
      menu_item_id: '11111111-1111-4111-8111-111111111111',
      category_id: '22222222-2222-4222-8222-222222222222',
      station_id: '33333333-3333-4333-8333-333333333333',
      customerName: 'Alice Customer',
    };
    const bareLine = { name: '   ', quantity: 0, station: ' bar ', notes: '   ' };
    // A stale caller that still passes customer PII must not leak it.
    const legacyProps = {
      enabled: true,
      isOpen: true,
      orderType: 'dine_in',
      customerName: 'Alice Customer',
      cartItems: [detailedLine, bareLine],
    };
    renderHook((props: HookProps) => useKdsLiveDraftSync(props), { initialProps: legacyProps });

    advance(400);

    expect(getKdsLocalDrafts()).toEqual([
      {
        scope: SCOPE,
        sessionId: expect.stringMatching(/\S/),
        orderType: 'dine-in',
        items: [
          {
            id: 'line-1',
            name: 'Margherita',
            quantity: 2,
            station: 'hot',
            notes: 'well done',
            modifiers: ['Extra cheese', 'No onion'],
          },
          { id: 'item-2', name: 'Unknown Item', quantity: 1, station: 'bar' },
        ],
        updatedAt: expect.any(String),
      },
    ]);
    const serialized = JSON.stringify(getKdsLocalDrafts());
    for (const forbidden of [
      'Alice',
      'customer',
      'price',
      'menu_item',
      'category',
      'station_id',
      detailedLine.menu_item_id,
      detailedLine.category_id,
      detailedLine.station_id,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('publishes nothing before the debounce elapses and restarts it on cart changes', () => {
    const view = renderDraftHook();
    advance(399);
    expect(getKdsLocalDrafts()).toEqual([]);

    view.update({ cartItems: [pizza, cola] });
    advance(399);
    expect(getKdsLocalDrafts()).toEqual([]);

    advance(1);
    expect(getKdsLocalDrafts()).toHaveLength(1);
    expect(getKdsLocalDrafts()[0].items.map((item) => item.name)).toEqual(['Margherita', 'Cola']);
  });

  it('skips the publish when the fingerprint is unchanged', () => {
    const notifications = vi.fn();
    unsubscribers.push(subscribeKdsLocalDrafts(notifications));
    const view = renderDraftHook();
    advance(400);
    expect(notifications).toHaveBeenCalledTimes(1);
    const [published] = getKdsLocalDrafts();

    // Equal content in fresh objects, as after an unrelated parent update.
    view.update({ cartItems: [{ ...pizza }], orderType: 'dine_in' });
    advance(1_000);
    expect(notifications).toHaveBeenCalledTimes(1);
    expect(getKdsLocalDrafts()[0]).toBe(published);

    view.update({ cartItems: [{ ...pizza, quantity: 3 }] });
    advance(400);
    expect(notifications).toHaveBeenCalledTimes(2);
    expect(getKdsLocalDrafts()[0].items[0].quantity).toBe(3);

    view.update({ orderType: 'takeaway' });
    advance(400);
    expect(notifications).toHaveBeenCalledTimes(3);
    expect(getKdsLocalDrafts()[0].orderType).toBe('pickup');
  });

  it('clears the published draft when the cart becomes empty', () => {
    const view = renderDraftHook();
    advance(400);
    expect(getKdsLocalDrafts()).toHaveLength(1);

    view.update({ cartItems: [] });
    advance(400);
    expect(getKdsLocalDrafts()).toEqual([]);

    view.update({ cartItems: [cola] });
    advance(400);
    expect(getKdsLocalDrafts()).toHaveLength(1);
  });

  it('clears the draft as soon as the modal closes, and a reopen starts a new session', () => {
    const view = renderDraftHook();
    advance(400);
    const [first] = getKdsLocalDrafts();
    expect(first).toBeDefined();

    view.update({ isOpen: false });
    expect(getKdsLocalDrafts()).toEqual([]);
    advance(1_000);
    expect(getKdsLocalDrafts()).toEqual([]);

    view.update({ isOpen: true });
    advance(400);
    expect(getKdsLocalDrafts()).toHaveLength(1);
    expect(getKdsLocalDrafts()[0].sessionId).not.toBe(first.sessionId);
  });

  it('clears the draft on unmount', () => {
    const view = renderDraftHook();
    advance(400);
    expect(getKdsLocalDrafts()).toHaveLength(1);

    view.unmount();
    expect(getKdsLocalDrafts()).toEqual([]);
    advance(1_000);
    expect(getKdsLocalDrafts()).toEqual([]);
  });

  it('clears the old scope before publishing under a new one, and clears when identity is lost', () => {
    const view = renderDraftHook();
    advance(400);
    expect(draftScopes()).toEqual([SCOPE]);
    const snapshots: string[][] = [];
    unsubscribers.push(subscribeKdsLocalDrafts(() => snapshots.push(draftScopes())));

    identity.current = { ...READY_IDENTITY, terminalId: 'terminal-2' };
    view.update();
    expect(getKdsLocalDrafts()).toEqual([]);
    advance(400);
    expect(draftScopes()).toEqual(['org-1|branch-1|terminal-2']);

    identity.current = { ...READY_IDENTITY, terminalId: 'terminal-2', isReady: false };
    view.update();
    expect(getKdsLocalDrafts()).toEqual([]);
    advance(1_000);

    // The old and new scopes never coexist in the store.
    expect(snapshots).toEqual([[], ['org-1|branch-1|terminal-2'], []]);
  });

  it('clears the draft and stops publishing when disabled for edit mode', () => {
    const view = renderDraftHook();
    advance(400);
    expect(getKdsLocalDrafts()).toHaveLength(1);

    view.update({ enabled: false });
    expect(getKdsLocalDrafts()).toEqual([]);
    view.update({ cartItems: [pizza, cola] });
    advance(1_000);
    expect(getKdsLocalDrafts()).toEqual([]);
  });

  it.each([
    ['the identity is not ready', { isReady: false }],
    ['the terminal id is missing', { terminalId: null }],
    ['the branch id is missing', { branchId: null }],
    ['the organization id is missing', { organizationId: null }],
  ])('never publishes when %s', (_reason, patch) => {
    identity.current = { ...READY_IDENTITY, ...patch };
    const view = renderDraftHook();
    advance(5_000);
    view.update({ cartItems: [pizza, cola] });
    advance(5_000);
    expect(getKdsLocalDrafts()).toEqual([]);
  });

  it('ignores a publish timer that still fires after close or unmount', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const takePendingPublish = () => {
      const publishCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === 400);
      const callback = publishCalls[publishCalls.length - 1]?.[0];
      expect(callback).toBeTypeOf('function');
      return callback as () => void;
    };
    try {
      const view = renderDraftHook();
      const firedAfterClose = takePendingPublish();
      view.update({ isOpen: false });
      act(() => firedAfterClose());
      expect(getKdsLocalDrafts()).toEqual([]);

      view.update({ isOpen: true });
      const firedAfterUnmount = takePendingPublish();
      expect(firedAfterUnmount).not.toBe(firedAfterClose);
      view.unmount();
      act(() => firedAfterUnmount());
      expect(getKdsLocalDrafts()).toEqual([]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('clearDrafts removes the current session draft until the cart changes again', async () => {
    const view = renderDraftHook();
    advance(400);
    expect(getKdsLocalDrafts()).toHaveLength(1);

    await act(async () => {
      await view.result.current.clearDrafts();
    });
    expect(getKdsLocalDrafts()).toEqual([]);
    advance(1_000);
    expect(getKdsLocalDrafts()).toEqual([]);

    view.update({ cartItems: [pizza, cola] });
    advance(400);
    expect(getKdsLocalDrafts()).toHaveLength(1);
  });
});
