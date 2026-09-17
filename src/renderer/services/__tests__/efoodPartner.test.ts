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

  it('defaults to enabled and silenced, and survives a corrupt stored value', () => {
    // The page rings for a new order and the POS plugin's modal rings after it.
    // Staff silenced efood's half in the browser's site settings, which the POS
    // window has no equivalent of, so a fresh register starts silenced.
    expect(readEfoodPartnerSettings()).toEqual({ enabled: true, muted: true });
    localStorage.setItem('pos-efood-partner-settings', '{not json');
    expect(readEfoodPartnerSettings()).toEqual({ enabled: true, muted: true });
  });

  it('keeps an explicit choice to hear efood instead of re-silencing it', () => {
    localStorage.setItem('pos-efood-partner-settings', JSON.stringify({ enabled: true, muted: false }));
    expect(readEfoodPartnerSettings()).toEqual({ enabled: true, muted: false });
  });

  it('persists a partial update on top of the current settings', () => {
    expect(writeEfoodPartnerSettings({ muted: false })).toEqual({ enabled: true, muted: false });
    expect(writeEfoodPartnerSettings({ enabled: false })).toEqual({ enabled: false, muted: false });
    expect(readEfoodPartnerSettings()).toEqual({ enabled: false, muted: false });
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

  /**
   * The native webview is a sibling of the whole page, not a child of this
   * container, so no CSS can clip it: whatever rectangle is reported is exactly
   * where it is painted. Reporting an unclipped rectangle is how efood's page
   * ended up hanging over the rounded container and the chrome around it.
   */
  it('keeps the page inside the window when its surface runs past the edge', () => {
    const element = {
      getBoundingClientRect: () => ({ left: 120, top: 40, width: 1400, height: 900, right: 1520, bottom: 940 }),
    } as unknown as HTMLElement;
    expect(measureEfoodPartnerBounds(element, { width: 1280, height: 800 })).toEqual({
      x: 120,
      y: 40,
      width: 1160,
      height: 760,
    });
  });

  it('keeps the page inside the window when its surface starts above or left of it', () => {
    const element = {
      getBoundingClientRect: () => ({ left: -60, top: -30, width: 800, height: 600, right: 740, bottom: 570 }),
    } as unknown as HTMLElement;
    expect(measureEfoodPartnerBounds(element, { width: 1280, height: 800 })).toEqual({
      x: 0,
      y: 0,
      width: 740,
      height: 570,
    });
  });

  it('reports nothing rather than a sliver when the surface is scrolled out of view', () => {
    const offscreen = {
      getBoundingClientRect: () => ({ left: 1400, top: 40, width: 800, height: 600, right: 2200, bottom: 640 }),
    } as unknown as HTMLElement;
    expect(measureEfoodPartnerBounds(offscreen, { width: 1280, height: 800 })).toBeNull();

    const above = {
      getBoundingClientRect: () => ({ left: 20, top: -900, width: 800, height: 600, right: 820, bottom: -300 }),
    } as unknown as HTMLElement;
    expect(measureEfoodPartnerBounds(above, { width: 1280, height: 800 })).toBeNull();
  });

  it('reports nothing while the window has no size to clip against', () => {
    const element = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    } as unknown as HTMLElement;
    expect(measureEfoodPartnerBounds(element, { width: 0, height: 0 })).toBeNull();
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
