/**
 * Shared state for the efood Partner page hosted in the POS: whether this
 * register may show it, and the local settings. The sidebar, the main layout
 * and Settings > Platforms all read it, so the availability read happens once
 * per session and settings changes reach every reader at once.
 */
import { useCallback, useEffect, useState } from 'react';
import { useModules } from '../contexts/module-context';
import { posApiGet } from '../utils/api-helpers';
import {
  EFOOD_PARTNER_SETTINGS_EVENT,
  efoodPartnerBridge,
  isEfoodPartnerAvailable,
  readEfoodPartnerSettings,
  writeEfoodPartnerSettings,
  type EfoodPartnerSettings,
} from '../services/efoodPartner';

const CONTROLLABLE_KEY = 'pos-efood-partner-controllable';

type PlatformsBody = { success?: boolean; platforms?: Array<{ plugin_id?: string; controllable?: boolean }> };

let controllable: boolean | null = null;
let inflight: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function readCachedControllable(): boolean {
  try {
    return localStorage.getItem(CONTROLLABLE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberControllable(value: boolean) {
  controllable = value;
  try {
    localStorage.setItem(CONTROLLABLE_KEY, value ? '1' : '0');
  } catch {
    // Best effort: the in-memory value serves this session.
  }
  for (const listener of listeners) listener();
}

/**
 * Asks the server whether efood is managed from this register (the same
 * platforms list Settings > Platforms shows). The last answer is kept so the
 * sidebar can show the module before the read completes or while offline.
 */
export async function refreshEfoodPartnerAvailability(): Promise<boolean> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await posApiGet<PlatformsBody>('/pos/platforms');
      const list = response?.data?.platforms;
      if (response?.success && Array.isArray(list)) {
        const efood = list.find((entry) => entry?.plugin_id === 'efood');
        rememberControllable(efood?.controllable === true);
      }
    } catch {
      // Keep the last known answer.
    } finally {
      inflight = null;
    }
    return controllable ?? readCachedControllable();
  })();
  return inflight;
}

/** Test-only: forget the session's availability read. */
export function resetEfoodPartnerAvailabilityForTests() {
  controllable = null;
  inflight = null;
}

export interface EfoodPartnerState {
  available: boolean;
  efoodControllable: boolean;
  settings: EfoodPartnerSettings;
  updateSettings: (patch: Partial<EfoodPartnerSettings>) => void;
}

export function useEfoodPartner(): EfoodPartnerState {
  const { isModuleEnabled } = useModules();
  const [settings, setSettings] = useState<EfoodPartnerSettings>(readEfoodPartnerSettings);
  const [efoodControllable, setEfoodControllable] = useState<boolean>(() => controllable ?? readCachedControllable());

  useEffect(() => {
    const sync = () => setEfoodControllable(controllable ?? readCachedControllable());
    listeners.add(sync);
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<EfoodPartnerSettings>).detail;
      setSettings(detail ?? readEfoodPartnerSettings());
    };
    window.addEventListener(EFOOD_PARTNER_SETTINGS_EVENT, onSettings);
    if (controllable === null) void refreshEfoodPartnerAvailability();
    return () => {
      listeners.delete(sync);
      window.removeEventListener(EFOOD_PARTNER_SETTINGS_EVENT, onSettings);
    };
  }, []);

  const updateSettings = useCallback((patch: Partial<EfoodPartnerSettings>) => {
    const next = writeEfoodPartnerSettings(patch);
    setSettings(next);
    if (patch.enabled === false) {
      void efoodPartnerBridge.close();
    } else if (patch.enabled === true) {
      void efoodPartnerBridge.ensure({ muted: next.muted });
    }
    if (typeof patch.muted === 'boolean') {
      void efoodPartnerBridge.setMuted(patch.muted);
    }
  }, []);

  const pluginIntegrationsEnabled = isModuleEnabled('plugin_integrations' as never);
  return {
    available: isEfoodPartnerAvailable({ pluginIntegrationsEnabled, efoodControllable, settings }),
    efoodControllable,
    settings,
    updateSettings,
  };
}
