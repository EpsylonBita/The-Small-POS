import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { posApiGet, bridge, modules } = vi.hoisted(() => ({
  posApiGet: vi.fn(),
  bridge: { ensure: vi.fn(), close: vi.fn(), setMuted: vi.fn(), show: vi.fn(), park: vi.fn() },
  modules: { enabled: new Set<string>(['plugin_integrations']) },
}));
vi.mock('../../utils/api-helpers', () => ({ posApiGet }));
vi.mock('../../contexts/module-context', () => ({
  useModules: () => ({ isModuleEnabled: (id: string) => modules.enabled.has(id) }),
}));
vi.mock('../../services/efoodPartner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/efoodPartner')>();
  return { ...actual, efoodPartnerBridge: bridge };
});

import { resetEfoodPartnerAvailabilityForTests, useEfoodPartner } from '../useEfoodPartner';

function platforms(controllable: boolean) {
  return { success: true, data: { success: true, platforms: [{ plugin_id: 'efood', controllable }] } };
}

/**
 * The hosted efood page is not a feature staff work in: it exists because efood
 * keeps the shop closed unless its own app is connected. So it appears only on
 * the register that actually manages efood — which the server answers with
 * `controllable`, and only for an organization that bought the plugin and has
 * it enabled and in effect (see the platform availability gate) — and only
 * while the org holds the plugin_integrations module.
 */
describe('useEfoodPartner availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    modules.enabled = new Set(['plugin_integrations']);
    resetEfoodPartnerAvailabilityForTests();
  });
  afterEach(() => {
    resetEfoodPartnerAvailabilityForTests();
  });

  it('shows the page where the server says efood is managed from this register', async () => {
    posApiGet.mockResolvedValue(platforms(true));
    const { result } = renderHook(() => useEfoodPartner());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(posApiGet).toHaveBeenCalledWith('/pos/platforms');
  });

  it('hides it where efood is not purchased, enabled or managed here', async () => {
    posApiGet.mockResolvedValue(platforms(false));
    const { result } = renderHook(() => useEfoodPartner());
    await waitFor(() => expect(posApiGet).toHaveBeenCalled());
    expect(result.current.available).toBe(false);
    expect(result.current.efoodControllable).toBe(false);
  });

  it('hides it when the platforms list carries no efood entry at all', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [] } });
    const { result } = renderHook(() => useEfoodPartner());
    await waitFor(() => expect(posApiGet).toHaveBeenCalled());
    expect(result.current.available).toBe(false);
  });

  it('hides it without the plugin_integrations module, however efood answers', async () => {
    posApiGet.mockResolvedValue(platforms(true));
    modules.enabled = new Set();
    const { result } = renderHook(() => useEfoodPartner());
    await waitFor(() => expect(posApiGet).toHaveBeenCalled());
    expect(result.current.available).toBe(false);
  });

  it('keeps the last known answer when the register is offline', async () => {
    localStorage.setItem('pos-efood-partner-controllable', '1');
    posApiGet.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useEfoodPartner());
    await waitFor(() => expect(posApiGet).toHaveBeenCalled());
    expect(result.current.available).toBe(true);
  });
});

describe('useEfoodPartner sound setting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    modules.enabled = new Set(['plugin_integrations']);
    resetEfoodPartnerAvailabilityForTests();
    posApiGet.mockResolvedValue(platforms(true));
    bridge.setMuted.mockResolvedValue({ success: true });
    bridge.ensure.mockResolvedValue({ success: true });
  });

  it('starts silenced, since the browser sound switch does not exist in the POS', async () => {
    const { result } = renderHook(() => useEfoodPartner());
    await waitFor(() => expect(result.current.settings.muted).toBe(true));
  });

  it('sends the sound change to the hosted page and keeps it for the next start', async () => {
    const { result } = renderHook(() => useEfoodPartner());
    await waitFor(() => expect(posApiGet).toHaveBeenCalled());

    await act(async () => {
      result.current.updateSettings({ muted: false });
      await Promise.resolve();
    });

    expect(bridge.setMuted).toHaveBeenCalledWith(false);
    expect(result.current.settings.muted).toBe(false);
    expect(JSON.parse(localStorage.getItem('pos-efood-partner-settings') ?? '{}')).toMatchObject({ muted: false });
  });

  it('loads the page silenced when it is switched back on', async () => {
    const { result } = renderHook(() => useEfoodPartner());
    await waitFor(() => expect(posApiGet).toHaveBeenCalled());

    await act(async () => {
      result.current.updateSettings({ enabled: false });
      result.current.updateSettings({ enabled: true });
      await Promise.resolve();
    });

    expect(bridge.close).toHaveBeenCalled();
    expect(bridge.ensure).toHaveBeenCalledWith({ muted: true });
  });
});
