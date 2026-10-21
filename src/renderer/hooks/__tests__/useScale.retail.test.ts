import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../../lib', () => ({ getBridge: () => ({ hardware: { scaleReadWeight: mocks.read } }) }));
import { useScale } from '../useScale';
beforeEach(() => { mocks.listen.mockResolvedValue(vi.fn()); });
describe('retail scale adapter', () => {
  it('retains the native read timestamp for checkout freshness validation', async () => {
    const readAt = '2026-10-20T10:00:00Z';
    mocks.read.mockResolvedValue({ success: true, weight: 0.425, unit: 'kg', stable: true, readAt });
    const { result, unmount } = renderHook(() => useScale());
    await act(async () => {
      expect(await result.current.readWeight()).toMatchObject({ weight: 0.425, stable: true, timestamp: readAt });
    });
    unmount();
  });
  it('never assumes a reading is stable when the driver did not say so', async () => {
    mocks.read.mockResolvedValue({ success: true, weight: 0.425, unit: 'kg' });
    const { result, unmount } = renderHook(() => useScale());
    await act(async () => { expect((await result.current.readWeight())?.stable).toBe(false); });
    unmount();
  });
  it('releases a late event subscription after checkout unmounts', async () => {
    let resolve!: (unlisten: () => void) => void;
    mocks.listen.mockImplementation(() => new Promise(done => { resolve = done; }));
    const { unmount } = renderHook(() => useScale());
    unmount();
    const unlisten = vi.fn();
    await act(async () => { resolve(unlisten); });
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
