import React from 'react';
import ReactDOM from 'react-dom';
import { useCashierOperationsLocked } from '../../contexts/cashier-gate-context';
import { useI18n } from '../../contexts/i18n-context';
import { takeOverBackdrop, type OpenGlassModal } from './modal-origin';
import '../../styles/glassmorphism.css';

/** A quick hand-over shows nothing; a slow one shows a quiet busy mark after this long. */
export const MODAL_BACKDROP_BRIDGE_BUSY_AFTER_MS = 400;

/** The next window never came (a failed load): the page is given back after this long. */
export const MODAL_BACKDROP_BRIDGE_GIVE_UP_MS = 4000;

interface ModalBackdropBridgeProps {
  /** True from the press that closed one window until the next window is on screen. */
  active: boolean;
  /** Called when the next window did not appear in time. */
  onGiveUp: () => void;
  giveUpAfterMs?: number;
}

/**
 * Holds the blurred backdrop between a window that closes and a window that needs a moment to
 * appear, because its screen is loaded on demand and opens the window itself (founder,
 * 11/11/2026: «σαν να φλασάρει κάτι»: the page showed sharp between the two).
 *
 * It only dims and blurs, and it is not a dialog. The closing window's own backdrop is dropped at
 * once (same rule as one glass window replacing another), so the dim never doubles and never
 * dips. Only a slow hand-over shows a busy mark, so the cashier is never left guessing.
 *
 * It is never drawn while the cashier gate is locked: a body portal escapes the locked till's
 * inert subtree, and a full-screen layer there could cover check-in or Health.
 */
export const ModalBackdropBridge: React.FC<ModalBackdropBridgeProps> = ({
  active,
  onGiveUp,
  giveUpAfterMs = MODAL_BACKDROP_BRIDGE_GIVE_UP_MS,
}) => {
  const { t } = useI18n();
  const cashierLocked = useCashierOperationsLocked();
  const backdropRef = React.useRef<HTMLDivElement>(null);
  const onGiveUpRef = React.useRef(onGiveUp);
  onGiveUpRef.current = onGiveUp;
  const [busy, setBusy] = React.useState(false);
  const entry = React.useMemo<OpenGlassModal>(
    () => ({ isOpen: () => true, backdrop: () => backdropRef.current }),
    [],
  );

  React.useLayoutEffect(() => {
    if (!active) return undefined;
    takeOverBackdrop(entry);
    const busyTimer = window.setTimeout(() => setBusy(true), MODAL_BACKDROP_BRIDGE_BUSY_AFTER_MS);
    const giveUpTimer = window.setTimeout(() => onGiveUpRef.current(), giveUpAfterMs);
    return () => {
      window.clearTimeout(busyTimer);
      window.clearTimeout(giveUpTimer);
      setBusy(false);
    };
  }, [active, entry, giveUpAfterMs]);

  if (!active || cashierLocked || typeof document === 'undefined') return null;
  return ReactDOM.createPortal(
    <>
      <div
        ref={backdropRef}
        data-modal-backdrop-bridge
        aria-hidden="true"
        className="liquid-glass-modal-backdrop liquid-glass-modal-backdrop--continued modal-backdrop-bridge"
      />
      {busy && (
        <div
          role="status"
          data-modal-backdrop-bridge-busy
          className="pos-enter pointer-events-none fixed inset-0 z-[999] flex items-center justify-center"
        >
          <span
            aria-hidden="true"
            className="h-8 w-8 animate-spin rounded-full border-[3px] border-(--pos-s-border) border-t-(--pos-s-sel-bg)"
          />
          <span className="sr-only">{t('common.loading')}</span>
        </div>
      )}
    </>,
    document.body,
  );
};

export default ModalBackdropBridge;
