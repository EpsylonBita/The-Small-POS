import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const getSettings = vi.fn();
  return { getSettings, bridge: { terminalConfig: { getSettings, refresh: vi.fn(async () => ({ success: true })) } }, handlers: new Map<string, (payload: unknown) => void>() };
});
vi.mock('../../../lib', () => ({
  getBridge: () => mocks.bridge,
  onEvent: (event: string, handler: (payload: unknown) => void) => mocks.handlers.set(event, handler),
  offEvent: (event: string) => mocks.handlers.delete(event),
}));
import { useTerminalSettings } from '../useTerminalSettings';

beforeEach(() => {
  mocks.getSettings.mockReset().mockResolvedValue({ terminal: { branch_id: 'branch-a' }, general: { language: 'el' } });
  mocks.handlers.clear();
});
afterEach(cleanup);

it.each([
  { updated: ['staff_auth_cache.branch-a'] },
  { key: 'local.customer_cache_v1' },
])('keeps terminal identity when a cache write is announced (%j)', async (payload) => {
  const { result } = renderHook(useTerminalSettings);
  await waitFor(() => expect(result.current.getSetting('terminal', 'branch_id')).toBe('branch-a'));
  act(() => mocks.handlers.get('terminal-settings-updated')?.(payload));
  expect(result.current.getSetting('terminal', 'branch_id')).toBe('branch-a');
  expect(mocks.getSettings).toHaveBeenCalledTimes(1);
});

it('reloads actual configuration after a key-only notification and keeps identity while loading', async () => {
  const { result } = renderHook(useTerminalSettings);
  await waitFor(() => expect(result.current.getSetting('terminal', 'branch_id')).toBe('branch-a'));
  let resolve!: (settings: unknown) => void;
  mocks.getSettings.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  act(() => mocks.handlers.get('terminal-settings-updated')?.({ updated: ['general.language'] }));
  expect(result.current.getSetting('terminal', 'branch_id')).toBe('branch-a');
  expect(mocks.getSettings).toHaveBeenCalledTimes(2);
  await act(async () => resolve({ terminal: { branch_id: 'branch-a' }, general: { language: 'de' } }));
  expect(result.current.getSetting('general', 'language')).toBe('de');
});

it('does not let an older configuration response replace a newer one', async () => {
  const { result } = renderHook(useTerminalSettings);
  await waitFor(() => expect(result.current.getSetting('terminal', 'branch_id')).toBe('branch-a'));
  let resolveOld!: (settings: unknown) => void;
  let resolveNew!: (settings: unknown) => void;
  mocks.getSettings
    .mockImplementationOnce(() => new Promise((done) => { resolveOld = done; }))
    .mockImplementationOnce(() => new Promise((done) => { resolveNew = done; }));
  act(() => mocks.handlers.get('terminal-settings-updated')?.({ updated: ['general.language'] }));
  act(() => mocks.handlers.get('terminal-settings-updated')?.({ updated: ['general.language'] }));
  expect(mocks.getSettings).toHaveBeenCalledTimes(3);
  await act(async () => resolveNew({ terminal: { branch_id: 'branch-b' } }));
  await act(async () => resolveOld({ terminal: { branch_id: 'branch-a' } }));
  expect(result.current.getSetting('terminal', 'branch_id')).toBe('branch-b');
});

it('manual refresh settles loading and supersedes an earlier startup response', async () => {
  let resolveOld!: (settings: unknown) => void;
  mocks.getSettings.mockImplementationOnce(() => new Promise((done) => { resolveOld = done; }));
  const { result } = renderHook(useTerminalSettings);
  await act(async () => { await result.current.refresh(); });
  expect(result.current.loading).toBe(false);
  expect(result.current.getSetting('terminal', 'branch_id')).toBe('branch-a');
  await act(async () => resolveOld({ terminal: { branch_id: 'obsolete' } }));
  expect(result.current.getSetting('terminal', 'branch_id')).toBe('branch-a');
});
