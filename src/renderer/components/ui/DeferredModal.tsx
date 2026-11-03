import React, { Suspense, useEffect, useState } from 'react';
import { useI18n } from '../../contexts/i18n-context';
import { LiquidGlassModal } from './pos-glass-components';

interface DeferredModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * The modal's own import, warmed once the till is idle so its first open is instant (founder 01/11/2026: settings
   * and the Z flashed a «Loading…» window the first time). Pass a module-level function, the same one `lazy()` uses.
   */
  preload?: () => Promise<unknown>;
}

/** How long a load may take before the cancellable loading window shows: a quick load shows nothing at all. */
export const DEFERRED_LOADING_DELAY_MS = 300;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** The loading window, only once the load is slow; until then a screen-reader status and nothing on screen. */
function DeferredLoading({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = window.setTimeout(() => setSlow(true), DEFERRED_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  if (!slow) {
    return isOpen ? <span role="status" className="sr-only">{t('common.loading')}</span> : null;
  }
  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('common.loading')}
      blur={false}
      closeMode="request"
    >
      <div role="status" className="flex items-center gap-3 text-sm liquid-glass-modal-text">
        <span
          aria-hidden="true"
          className="h-6 w-6 shrink-0 animate-spin rounded-full border-[3px] border-(--pos-s-border) border-t-(--pos-s-sel-bg)"
        />
        {t('common.loading')}
      </div>
    </LiquidGlassModal>
  );
}

/** Load on first use, then preserve the modal's state and closing lifecycle. */
export function DeferredModal({ isOpen, onClose, children, preload }: DeferredModalProps) {
  const [hasOpened, setHasOpened] = useState(isOpen);

  useEffect(() => {
    if (isOpen) setHasOpened(true);
  }, [isOpen]);

  // Warm the modal's code once the till is idle; a failed warm-up changes nothing (the open loads it again).
  useEffect(() => {
    if (!preload) return undefined;
    const idle = window as IdleWindow;
    let cancelled = false;
    const warm = () => {
      if (!cancelled) void preload().catch(() => undefined);
    };
    if (typeof idle.requestIdleCallback === 'function') {
      const handle = idle.requestIdleCallback(warm, { timeout: 5000 });
      return () => {
        cancelled = true;
        idle.cancelIdleCallback?.(handle);
      };
    }
    const timer = window.setTimeout(warm, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [preload]);

  if (!isOpen && !hasOpened) return null;

  return (
    <Suspense fallback={<DeferredLoading isOpen={isOpen} onClose={onClose} />}>
      {children}
    </Suspense>
  );
}
