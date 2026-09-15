import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListOrdered, RefreshCw } from 'lucide-react';
import { liquidGlassModalButton } from '../styles/designSystem';
import {
  EFOOD_PARTNER_HOME_URL,
  efoodPartnerBridge,
  measureEfoodPartnerBounds,
  readEfoodPartnerSettings,
} from '../services/efoodPartner';

/**
 * The efood Partner (Live Orders) module. The page itself is a native
 * webview the Rust side places over this component's surface; React only
 * measures the surface, reports its bounds, and parks the webview when a
 * dialog opens over it or the module is left. The page keeps running while
 * parked, which is the point: efood keeps the shop open only while its own
 * app is connected.
 */
export const EfoodPartnerView: React.FC = () => {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const showRef = useRef<() => Promise<void>>(async () => {});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return undefined;
    let disposed = false;
    let dialogOpen = false;

    const show = async () => {
      if (disposed || dialogOpen) return;
      const bounds = measureEfoodPartnerBounds(surface);
      if (!bounds) return;
      const result = await efoodPartnerBridge.show(bounds, { muted: readEfoodPartnerSettings().muted });
      if (!disposed) setFailed(!result.success);
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
        </div>
      </div>
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
