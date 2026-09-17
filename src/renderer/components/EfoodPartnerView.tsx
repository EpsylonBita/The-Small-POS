import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListOrdered, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { liquidGlassModalButton } from '../styles/designSystem';
import {
  EFOOD_PARTNER_HOME_URL,
  EFOOD_PARTNER_SETTINGS_EVENT,
  efoodPartnerBridge,
  measureEfoodPartnerBounds,
  readEfoodPartnerSettings,
  writeEfoodPartnerSettings,
  type EfoodPartnerSettings,
} from '../services/efoodPartner';

/**
 * The efood Partner (Live Orders) module. The page itself is a native
 * webview the Rust side places over this component's surface; React only
 * measures the surface, reports its bounds, and parks the webview when a
 * dialog opens over it or the module is left. The page keeps running while
 * parked, which is the point: efood keeps the shop open only while its own
 * app is connected.
 *
 * This module exists so efood's app is RUNNING, not so anyone works in it.
 * Staff take orders in the POS; this is the always-on device efood requires.
 * Hence the sound control: efood's page rings for a new order and the POS
 * plugin's own modal rings straight after it, so the till alerts twice for one
 * order. Silencing efood's half leaves the POS as the single voice.
 */
export const EfoodPartnerView: React.FC = () => {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const showRef = useRef<() => Promise<void>>(async () => {});
  const [failed, setFailed] = useState(false);
  const [muted, setMuted] = useState<boolean>(() => readEfoodPartnerSettings().muted);
  const [soundFailed, setSoundFailed] = useState(false);
  // The live value for the placement effect, which must not re-run (and so
  // reload the page) every time the sound is toggled.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Settings > Platforms carries the same switch. Follow it so the two never
  // disagree about whether efood is making noise.
  useEffect(() => {
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<EfoodPartnerSettings>).detail;
      setMuted((detail ?? readEfoodPartnerSettings()).muted);
    };
    window.addEventListener(EFOOD_PARTNER_SETTINGS_EVENT, onSettings);
    return () => window.removeEventListener(EFOOD_PARTNER_SETTINGS_EVENT, onSettings);
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return undefined;
    let disposed = false;
    let dialogOpen = false;

    // Placement is async, and a resize fires many times. Without a generation
    // stamp an older measurement can finish last and leave the page at the size
    // the window used to be — the other half of why it hung outside the
    // container. Only the newest call is allowed to report its result.
    let generation = 0;

    const show = async () => {
      if (disposed || dialogOpen) return;
      const bounds = measureEfoodPartnerBounds(surface);
      if (!bounds) return;
      const mine = ++generation;
      const result = await efoodPartnerBridge.show(bounds, { muted: mutedRef.current });
      if (disposed || mine !== generation) return;
      setFailed(!result.success);
      // Placement never fails over the sound, so a mute the page refused at
      // startup is reported here instead of passing for silence.
      setSoundFailed(result.success && result.muteFailed === true);
    };
    showRef.current = show;
    void show();

    const resizeObserver = new ResizeObserver(() => {
      void show();
    });
    resizeObserver.observe(surface);
    const onWindowResize = () => {
      void show();
    };
    window.addEventListener('resize', onWindowResize);

    // A native webview sits above every DOM element, so a modal opened over
    // this module would be hidden behind efood's page: park it while any
    // dialog is open and bring it back once the dialog closes.
    const dialogs = new MutationObserver(() => {
      const open = document.querySelector('[role="dialog"]') !== null;
      if (open === dialogOpen) return;
      dialogOpen = open;
      if (open) {
        void efoodPartnerBridge.park();
      } else {
        void show();
      }
    });
    dialogs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dialogs.disconnect();
      window.removeEventListener('resize', onWindowResize);
      void efoodPartnerBridge.park();
    };
  }, []);

  const reload = async () => {
    setFailed(false);
    await efoodPartnerBridge.navigate();
    await showRef.current();
  };

  const goHome = async () => {
    setFailed(false);
    await efoodPartnerBridge.navigate(EFOOD_PARTNER_HOME_URL);
    await showRef.current();
  };

  const toggleMuted = async () => {
    const next = !muted;
    setMuted(next);
    setSoundFailed(false);
    const result = await efoodPartnerBridge.setMuted(next);
    if (!result.success) {
      // A button that says "sound off" while efood keeps ringing is the exact
      // problem this control exists to solve: put it back where it was.
      setMuted(!next);
      setSoundFailed(true);
      return;
    }
    // Persist only what the page accepted; writeEfoodPartnerSettings raises the
    // shared event, so Settings > Platforms follows this button without a round
    // trip.
    writeEfoodPartnerSettings({ muted: next });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="efood-partner-view">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold liquid-glass-modal-text">efood</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void reload()} className={liquidGlassModalButton('secondary', 'sm')}>
            <span className="inline-flex items-center gap-2">
              <RefreshCw className="h-4 w-4" />
              {t('settings.platforms.efoodPartner.reload', 'Reload')}
            </span>
          </button>
          <button type="button" onClick={() => void goHome()} className={liquidGlassModalButton('secondary', 'sm')}>
            <span className="inline-flex items-center gap-2">
              <ListOrdered className="h-4 w-4" />
              {t('settings.platforms.efoodPartner.home', 'Live orders')}
            </span>
          </button>
          <button
            type="button"
            onClick={() => void toggleMuted()}
            data-testid="efood-partner-sound"
            data-muted={muted ? 'true' : 'false'}
            aria-pressed={muted}
            className={liquidGlassModalButton('secondary', 'sm')}
            aria-label={muted
              ? t('settings.platforms.efoodPartner.soundOff', 'efood sound off')
              : t('settings.platforms.efoodPartner.soundOn', 'efood sound on')}
          >
            <span className="inline-flex items-center gap-2">
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              {muted
                ? t('settings.platforms.efoodPartner.soundOff', 'efood sound off')
                : t('settings.platforms.efoodPartner.soundOn', 'efood sound on')}
            </span>
          </button>
        </div>
      </div>
      {soundFailed && (
        <p className="shrink-0 text-xs liquid-glass-modal-text" data-testid="efood-partner-sound-error">
          {t(
            'settings.platforms.efoodPartner.soundFailed',
            'The efood page did not accept the sound change. Reload the page and try again.',
          )}
        </p>
      )}
      <div
        ref={surfaceRef}
        data-testid="efood-partner-surface"
        className="relative flex-1 min-h-0 overflow-hidden rounded-xl border liquid-glass-modal-border bg-black/5 dark:bg-white/5"
      >
        {failed && (
          <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-sm liquid-glass-modal-text">
            {t(
              'settings.platforms.efoodPartner.unavailable',
              'The efood page could not be shown on this register. Reload, or restart the POS.',
            )}
          </p>
        )}
      </div>
    </div>
  );
};

export default EfoodPartnerView;
