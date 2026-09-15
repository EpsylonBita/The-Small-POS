/**
 * efood Partner (Live Orders) hosted inside the POS.
 *
 * efood keeps a shop closed (`close_unreachable`) unless one of its own
 * devices is connected, and its Partner API cannot say "the POS is here"
 * (efood, 15/09/2026: their equipment stays required as the fallback for
 * orders that fail to transmit). Instead of a separate browser on the till,
 * the POS hosts efood's web app in a second webview inside its own window:
 * staff reach it as a module from the sidebar, and it keeps running while
 * other modules are shown, so efood sees its equipment connected all day.
 *
 * This module owns the local settings, the availability rule and the bridge
 * to the Rust commands that create, place, park and close that webview.
 */
import { getBridge } from '../../lib';

export const EFOOD_PARTNER_VIEW = 'efood_partner';
export const EFOOD_PARTNER_HOME_URL = 'https://partner-app.e-food.gr/live-orders';
export const EFOOD_PARTNER_SETTINGS_KEY = 'pos-efood-partner-settings';
/** Window event raised after the settings change, so every reader updates. */
export const EFOOD_PARTNER_SETTINGS_EVENT = 'pos-efood-partner-settings-changed';

export interface EfoodPartnerSettings {
  /** Host the page in the POS (and load it at startup). */
  enabled: boolean;
  /** Mute efood's own order sounds; the POS plays its own alert. */
  muted: boolean;
}

/** Logical pixels, relative to the POS window's content area. */
export interface EfoodPartnerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EfoodPartnerStatus {
  success: boolean;
  exists?: boolean;
  parked?: boolean;
  muted?: boolean;
  url?: string | null;
}

const DEFAULT_SETTINGS: EfoodPartnerSettings = { enabled: true, muted: false };

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readEfoodPartnerSettings(): EfoodPartnerSettings {
  const raw = storage()?.getItem(EFOOD_PARTNER_SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<EfoodPartnerSettings> | null;
    return {
      enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : DEFAULT_SETTINGS.enabled,
      muted: typeof parsed?.muted === 'boolean' ? parsed.muted : DEFAULT_SETTINGS.muted,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeEfoodPartnerSettings(patch: Partial<EfoodPartnerSettings>): EfoodPartnerSettings {
  const next = { ...readEfoodPartnerSettings(), ...patch };
  try {
    storage()?.setItem(EFOOD_PARTNER_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable; the in-memory value still applies this session.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EFOOD_PARTNER_SETTINGS_EVENT, { detail: next }));
  }
  return next;
}

/**
 * The module shows only where it makes sense: the org has the plugin
 * integrations module, this register is the one that manages efood (the
 * platforms list marks efood controllable only there), and the setting is on.
 */
export function isEfoodPartnerAvailable(args: {
  pluginIntegrationsEnabled: boolean;
  efoodControllable: boolean;
  settings: EfoodPartnerSettings;
}): boolean {
  return args.pluginIntegrationsEnabled && args.efoodControllable && args.settings.enabled;
}

/** Whole logical pixels; null while the surface has no size (not laid out yet). */
export function measureEfoodPartnerBounds(element: HTMLElement): EfoodPartnerBounds | null {
  const rect = element.getBoundingClientRect();
  const bounds = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  if (bounds.width < 1 || bounds.height < 1 || bounds.x < 0 || bounds.y < 0) return null;
  return bounds;
}

async function call(channel: string, payload?: Record<string, unknown>): Promise<EfoodPartnerStatus> {
  try {
    const bridge = getBridge();
    const result = payload === undefined ? await bridge.invoke(channel) : await bridge.invoke(channel, payload);
    return result && typeof result === 'object' ? (result as EfoodPartnerStatus) : { success: false };
  } catch {
    // The page is efood's; a failure here only means the POS could not place
    // it, which the view reports instead of throwing into the shell.
    return { success: false };
  }
}

export const efoodPartnerBridge = {
  /** Load the page parked out of sight (used at startup). */
  ensure: (options: { muted: boolean }) =>
    call('efood-partner:ensure', { url: EFOOD_PARTNER_HOME_URL, muted: options.muted }),
  /** Place the page over the given surface. */
  show: (bounds: EfoodPartnerBounds, options: { muted: boolean }) =>
    call('efood-partner:show', { url: EFOOD_PARTNER_HOME_URL, bounds, muted: options.muted }),
  /** Move it out of sight; it keeps running. */
  park: () => call('efood-partner:park'),
  close: () => call('efood-partner:close'),
  status: () => call('efood-partner:status'),
  /** Load an efood page again; Live Orders when none is given. */
  navigate: (url?: string) => call('efood-partner:navigate', { url: url ?? EFOOD_PARTNER_HOME_URL }),
  setMuted: (muted: boolean) => call('efood-partner:set-muted', { muted }),
};
