import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import React, { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';

/**
 * The delivery platforms accept only their official cancellation reason codes
 * (efood partner API enum) — free text never reaches them. For platform
 * orders the operator picks one of these, so the platform receives a reason
 * it recognizes; any extra note stays internal (appended after « — »).
 */
export const PLATFORM_CANCELLATION_REASONS = [
  'CLOSED',
  'ITEM_UNAVAILABLE',
  'TOO_BUSY',
  'NO_COURIER',
  'ADDRESS_INCOMPLETE_MISSTATED',
  'OUTSIDE_DELIVERY_AREA',
  'BAD_WEATHER',
  'DUPLICATE_ORDER',
  'TEST_ORDER',
] as const;
export type PlatformCancellationReason = typeof PLATFORM_CANCELLATION_REASONS[number];

const platformReasonLabelKey = (code: PlatformCancellationReason) =>
  `modals.orderCancellation.platformReasons.${code.toLowerCase()}`;

export type CancellationReturnChannel = 'cash_drawer' | 'bank';

interface OrderCancellationModalProps {
  isOpen: boolean;
  orderCount: number;
  /** True when any order being cancelled came from a delivery platform. */
  platformOrder?: boolean;
  boxLocalCancellation?: boolean;
  manualReturn?: { amountCents: number; currency: string };
  recovery?: { reason: string; returnChannel?: CancellationReturnChannel };
  /**
   * A saved table cancellation that a manager may clear: refused by the
   * server (never sent again, nothing returned), or waiting for its server
   * outcome. Clearing never charges, returns or cancels anything; the till
   * refuses it while money may still have been recorded.
   */
  savedAttempt?: { refused: boolean; onRelease: () => void | Promise<void> };
  onConfirmCancel: (reason: string, returnChannel?: CancellationReturnChannel) => void | Promise<void>;
  onClose: () => void;
}

export const OrderCancellationModal: React.FC<OrderCancellationModalProps> = ({
  isOpen,
  orderCount,
  platformOrder = false,
  boxLocalCancellation = false,
  manualReturn,
  recovery,
  savedAttempt,
  onConfirmCancel,
  onClose
}) => {
  
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

  const { t, i18n } = useTranslation();
  const [cancelReason, setCancelReason] = useState('');
  const [returnChannel, setReturnChannel] = useState<CancellationReturnChannel>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [platformCode, setPlatformCode] = useState<PlatformCancellationReason | null>(null);
  const reasonInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Picking a chip pre-fills the note with its label (and unpicking clears
  // it), but an operator-typed note is never overwritten.
  const selectPlatformCode = (code: PlatformCancellationReason, selected: boolean) => {
    const previousLabel = platformCode ? t(platformReasonLabelKey(platformCode)) : null;
    if (selected) {
      setPlatformCode(null);
      setCancelReason((current) => (current.trim() === previousLabel ? '' : current));
      return;
    }
    const label = t(platformReasonLabelKey(code));
    setPlatformCode(code);
    setCancelReason((current) => {
      const trimmed = current.trim();
      if (!trimmed || trimmed === previousLabel) {
        return label;
      }
      return current;
    });
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      reasonInputRef.current?.focus();
      reasonInputRef.current?.select();
    }, 75);

    return () => window.clearTimeout(focusTimer);
  }, [isOpen, returnChannel]);

  useEffect(() => {
    if (!isOpen) resetForm();
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && recovery) {
      setCancelReason(recovery.reason);
      setReturnChannel(recovery.returnChannel);
    }
  }, [isOpen, recovery?.reason, recovery?.returnChannel]);

  const resetForm = () => {
    setCancelReason('');
    setPlatformCode(null);
    setReturnChannel(undefined);
  };

  const needsChannel = Boolean(manualReturn) && !returnChannel && !savedAttempt?.refused;
  const canConfirm = !submitting && !needsChannel && !savedAttempt?.refused
    && (platformOrder ? platformCode !== null : Boolean(cancelReason.trim()));

  const handleRelease = async () => {
    if (submittingRef.current || !savedAttempt) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await savedAttempt.onRelease();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleConfirm = async () => {
    if (submittingRef.current || needsChannel) return;
    if (platformOrder && !platformCode) {
      toast.error(t('modals.orderCancellation.platformReasonRequired'));
      return;
    }
    if (!platformOrder && !cancelReason.trim()) {
      toast.error(t('modals.orderCancellation.reasonRequired'));
      return;
    }
    // Platform orders lead with the official code so the platform recognizes
    // it; the operator's own note rides after « — » for our records only.
    const note = cancelReason.trim();
    const reason = platformCode
      ? (note ? `${platformCode} — ${note}` : platformCode)
      : note;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onConfirmCancel(reason, returnChannel);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submittingRef.current) return;
    resetForm();
    onClose();
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('modals.orderCancellation.title')}
      size="md"
      className="max-w-lg! [&_.liquid-glass-modal-header]:border-b-0!"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      initialFocusRef={reasonInputRef}
      footer={(
        /* Fixed actions: neutral safe close + red destructive confirm (disabled until a reason is given). */
        <div className="flex gap-3 px-6 pb-5 pt-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="liquid-glass-modal-button liquid-glass-modal-secondary flex-1 rounded-xl"
          >
            {t('modals.orderCancellation.keepOrder')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className={`liquid-glass-modal-button flex-1 rounded-xl disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed ${
              canConfirm
                ? 'bg-red-600! text-white! border-red-600! active:bg-red-700! shadow-md'
                : 'liquid-glass-modal-error'
            }`}
          >
            {t('modals.orderCancellation.confirm')}
          </button>
        </div>
      )}
    >
      <p className="liquid-glass-modal-text-muted mb-6">
        {t('modals.orderCancellation.message', { count: orderCount })}
      </p>

      <AnimatePresence initial={false}>{savedAttempt && (
        <motion.div {...revealMotion}
          data-testid="order-cancellation-saved-attempt"
          role={savedAttempt.refused ? 'alert' : 'status'}
          className="pos-glass-form-card mb-3 p-3! text-sm liquid-glass-modal-text"
        >
          <p className="mb-3">
            {t(savedAttempt.refused
              ? 'modals.orderCancellation.refusedAttemptNotice'
              : 'modals.orderCancellation.pendingAttemptNotice')}
          </p>
          <button
            type="button"
            onClick={() => { void handleRelease(); }}
            disabled={submitting}
            className="liquid-glass-modal-button liquid-glass-modal-secondary min-h-touch w-full rounded-xl disabled:opacity-50"
          >
            {t('modals.orderCancellation.clearRefusedAttempt')}
          </button>
        </motion.div>
      )}</AnimatePresence>

      <AnimatePresence initial={false}>{manualReturn && !recovery && (
        <motion.fieldset {...revealMotion} className="pos-glass-form-card mb-3" disabled={submitting}>
          <legend className="mb-2 font-medium liquid-glass-modal-text">{t('modals.orderCancellation.returnChannel')}</legend>
          <p className="mb-3 text-sm liquid-glass-modal-text-muted">
            {t('modals.orderCancellation.returnRecorded', { amount: new Intl.NumberFormat(i18n?.resolvedLanguage || i18n?.language, { style: 'currency', currency: manualReturn.currency }).format(manualReturn.amountCents / 100) })}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {(['cash_drawer', 'bank'] as const).map((channel) => (
              <button key={channel} type="button" aria-pressed={returnChannel === channel}
                onClick={() => setReturnChannel(channel)}
                className={`min-h-touch rounded-xl border px-4 py-3 font-medium ${returnChannel === channel ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg)' : 'pos-glass-field'}`}>
                {t(`modals.orderCancellation.${channel === 'cash_drawer' ? 'cashDrawer' : 'bank'}`)}
              </button>
            ))}
          </div>
        </motion.fieldset>
      )}</AnimatePresence>

      {boxLocalCancellation && (
        <p role="note" className="pos-glass-form-card mb-3 text-sm liquid-glass-modal-text">
          {t('boxOrder.localCancellationNotice')}
        </p>
      )}
      <AnimatePresence initial={false}>{!needsChannel && !savedAttempt?.refused && <motion.div {...revealMotion}><>
      <AnimatePresence initial={false}>{platformOrder && (
        <motion.div {...revealMotion} className="pos-glass-form-card mb-3">
          <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-2">
            {t('modals.orderCancellation.platformReasonLabel')}
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {PLATFORM_CANCELLATION_REASONS.map((code) => {
              const selected = platformCode === code;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => selectPlatformCode(code, selected)}
                  aria-pressed={selected}
                  className={`min-h-touch rounded-xl border px-3 py-2 text-left text-sm transition ${
                    selected
                      ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg) shadow-[var(--pos-s-depth-card)] active:translate-y-px active:shadow-[var(--pos-s-depth-press)]'
                      : 'pos-glass-field'
                  }`}
                >
                  {t(platformReasonLabelKey(code))}
                </button>
              );
            })}
          </div>
          <div className="text-xs liquid-glass-modal-text-muted mt-2">
            {t('modals.orderCancellation.platformReasonHint')}
          </div>
        </motion.div>
      )}</AnimatePresence>

      <div className="pos-glass-form-card mb-3">
        <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-2">
          {platformOrder
            ? t('modals.orderCancellation.internalNoteLabel')
            : t('modals.orderCancellation.reasonLabel')}
        </label>
        <textarea
          ref={reasonInputRef}
          value={cancelReason}
          readOnly={Boolean(recovery)}
          disabled={submitting}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder={t('modals.orderCancellation.reasonPlaceholder')}
          className="liquid-glass-modal-input pos-glass-field min-h-touch w-full resize-none"
          rows={platformOrder ? 2 : 4}
          maxLength={500}
        />
        <div className="text-xs liquid-glass-modal-text-muted mt-1">
          {t('modals.orderCancellation.characterCount', { current: cancelReason.length, max: 500 })}
        </div>
      </div>
      </></motion.div>}</AnimatePresence>
    </LiquidGlassModal>
  );
};

export default OrderCancellationModal;
