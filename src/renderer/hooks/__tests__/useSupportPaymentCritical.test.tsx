import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSupportPaymentCritical } from '../useSupportPaymentCritical';

const mocks = vi.hoisted(() => ({ ipc: vi.fn(), sessionId: null as string | null, state: null as string | null }));
vi.mock('../../../lib/ipc-adapter', () => ({ supportIpc: mocks.ipc }));
vi.mock('../useSupportSession', () => ({ useSupportSession: () => ({ snapshot: { session_id: mocks.sessionId, state: mocks.state } }) }));
beforeEach(() => { mocks.ipc.mockReset().mockResolvedValue({}); mocks.sessionId = null; mocks.state = null; });
afterEach(cleanup);
const opens = () => mocks.ipc.mock.calls.filter(([command]) => command === 'support_payment_open');
const closes = () => mocks.ipc.mock.calls.filter(([command]) => command === 'support_payment_closed');

it('opens before input, keeps one UUID across renders, closes on cancel and never reuses it', async () => {
  const hook = renderHook(({ open }) => useSupportPaymentCritical(open), { initialProps: { open: true } });
  const token = opens()[0][1].token;
  expect(token).toMatch(/^[a-f0-9-]{36}$/);
  hook.rerender({ open: true });
  expect(opens()).toHaveLength(1);
  act(() => hook.result.current.close());
  expect(closes()).toEqual([['support_payment_closed', { token }]]);
  await act(async () => { await hook.result.current.run(async () => undefined); });
  expect(opens()).toHaveLength(3);
  expect(opens()[1][1].token).not.toBe(token);
});

it('holds through an awaited save, releases on error and gives a retry a fresh token', async () => {
  const hook = renderHook(() => useSupportPaymentCritical(true));
  let finish: () => void = () => {};
  const saved = new Promise<void>(resolve => { finish = resolve; });
  let pending: Promise<void> = Promise.resolve();
  act(() => { pending = hook.result.current.run(() => saved); });
  expect(closes()).toHaveLength(0);
  await act(async () => { finish(); await pending; });
  expect(closes()).toHaveLength(1);
  await act(async () => {
    await expect(hook.result.current.run(async () => { throw new Error('SALE_FAILED'); })).rejects.toThrow('SALE_FAILED');
  });
  expect(new Set(opens().map(([, payload]) => payload.token)).size).toBe(3);
  expect(closes()).toHaveLength(2);
});

it('reasserts for a new support generation while saving and releases that generation after save', async () => {
  mocks.sessionId = 'your_session_one'; mocks.state = 'connected';
  const hook = renderHook(() => useSupportPaymentCritical(true));
  let finish: () => void = () => {};
  let pending: Promise<void> = Promise.resolve();
  act(() => { pending = hook.result.current.run(() => new Promise(resolve => { finish = resolve; })); });
  mocks.state = 'ended'; hook.rerender();
  mocks.sessionId = 'your_session_two'; mocks.state = 'connected'; hook.rerender();
  const tokens = opens().map(([, payload]) => payload.token);
  expect(new Set(tokens).size).toBe(3);
  await act(async () => { finish(); await pending; });
  expect(closes().map(([, payload]) => payload.token)).toEqual(tokens);
});

it('never waits for support or replaces a business result and cleans up a delayed/failed open', async () => {
  mocks.ipc.mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(() => useSupportPaymentCritical(true), { wrapper: React.StrictMode });
  const operation = vi.fn().mockResolvedValue('sale saved');
  await act(async () => { await expect(hook.result.current.run(operation)).resolves.toBe('sale saved'); });
  expect(operation).toHaveBeenCalledOnce();
  hook.unmount();
  for (const [, payload] of opens()) { expect(closes()).toContainEqual(['support_payment_closed', payload]); }
  mocks.ipc.mockRejectedValue(new Error('SUPPORT_FAILED'));
  const retry = renderHook(() => useSupportPaymentCritical(true));
  await act(async () => { await expect(retry.result.current.run(async () => 42)).resolves.toBe(42); });
  retry.unmount();
});

it('protects retry input in a still-open modal and closes on prop close and unmount', async () => {
  const hook = renderHook(({ open }) => useSupportPaymentCritical(open), { initialProps: { open: true } });
  await act(async () => { await hook.result.current.run(async () => undefined); });
  mocks.sessionId = 'your_new_session'; hook.rerender({ open: true });
  expect(opens()).toHaveLength(3);
  hook.rerender({ open: false });
  hook.rerender({ open: true });
  expect(opens()).toHaveLength(4);
  hook.unmount();
  expect(closes()).toHaveLength(4);
});
