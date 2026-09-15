import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../../../lib', () => ({ getBridge: () => ({ invoke }) }));

import {
  EFOOD_PARTNER_HOME_URL,
  EFOOD_PARTNER_VIEW,
  efoodPartnerBridge,
  isEfoodPartnerAvailable,
  measureEfoodPartnerBounds,
  readEfoodPartnerSettings,
  writeEfoodPartnerSettings,
} from '../efoodPartner';

describe('efood Partner settings', () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
  });

  it('defaults to enabled and not muted, and survives a corrupt stored value', () => {
    expect(readEfoodPartnerSettings()).toEqual({ enabled: true, muted: false });
    localStorage.setItem('pos-efood-partner-settings', '{not json');
    expect(readEfoodPartnerSettings()).toEqual({ enabled: true, muted: false });
  });

  it('persists a partial update on top of the current settings', () => {
    expect(writeEfoodPartnerSettings({ muted: true })).toEqual({ enabled: true, muted: true });
    expect(writeEfoodPartnerSettings({ enabled: false })).toEqual({ enabled: false, muted: true });
    expect(readEfoodPartnerSettings()).toEqual({ enabled: false, muted: true });
  });
});

describe('efood Partner availability', () => {
  const settings = { enabled: true, muted: false };

  it('needs the plugin_integrations module, a controllable efood platform and the setting on', () => {
    expect(isEfoodPartnerAvailable({ pluginIntegrationsEnabled: true, efoodControllable: true, settings })).toBe(true);
    expect(isEfoodPartnerAvailable({ pluginIntegrationsEnabled: false, efoodControllable: true, settings })).toBe(false);
    expect(isEfoodPartnerAvailable({ pluginIntegrationsEnabled: true, efoodControllable: false, settings })).toBe(false);
    expect(isEfoodPartnerAvailable({ pluginIntegrationsEnabled: true, efoodControllable: true, settings: { ...settings, enabled: false } })).toBe(false);
  });
});

describe('efood Partner bounds', () => {
  it('rounds the element rectangle to whole logical pixels and refuses an empty one', () => {
    const element = {
      getBoundingClientRect: () => ({ left: 120.4, top: 40.6, width: 900.2, height: 610.7 }),
    } as unknown as HTMLElement;
    expect(measureEfoodPartnerBounds(element)).toEqual({ x: 120, y: 41, width: 900, height: 611 });

    const empty = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) } as unknown as HTMLElement;
    expect(measureEfoodPartnerBounds(empty)).toBeNull();
  });
});

describe('efood Partner bridge', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ success: true, exists: true, parked: false, url: EFOOD_PARTNER_HOME_URL });
  });

  it('names the view and the Live Orders page', () => {
    expect(EFOOD_PARTNER_VIEW).toBe('efood_partner');
    expect(EFOOD_PARTNER_HOME_URL).toBe('https://partner-app.e-food.gr/live-orders');
  });

  it('shows the page at the given bounds through the efood-partner commands', async () => {
    const bounds = { x: 120, y: 41, width: 900, height: 611 };
    await efoodPartnerBridge.show(bounds, { muted: true });
    expect(invoke).toHaveBeenCalledWith('efood-partner:show', { url: EFOOD_PARTNER_HOME_URL, bounds, muted: true });

    await efoodPartnerBridge.ensure({ muted: false });
    expect(invoke).toHaveBeenCalledWith('efood-partner:ensure', { url: EFOOD_PARTNER_HOME_URL, muted: false });

    await efoodPartnerBridge.park();
    expect(invoke).toHaveBeenCalledWith('efood-partner:park');

    await efoodPartnerBridge.navigate();
    expect(invoke).toHaveBeenCalledWith('efood-partner:navigate', { url: EFOOD_PARTNER_HOME_URL });

    await efoodPartnerBridge.setMuted(true);
    expect(invoke).toHaveBeenCalledWith('efood-partner:set-muted', { muted: true });

    await efoodPartnerBridge.close();
    expect(invoke).toHaveBeenCalledWith('efood-partner:close');
  });

  it('reports a failed command as not shown instead of throwing into the UI', async () => {
    invoke.mockRejectedValueOnce(new Error('main window not found'));
    await expect(efoodPartnerBridge.show({ x: 0, y: 0, width: 10, height: 10 }, { muted: false }))
      .resolves.toEqual({ success: false });
  });
});
