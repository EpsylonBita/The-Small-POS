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

interface OrderCancellationModalProps {
  isOpen: boolean;
  orderCount: number;
  /** True when any order being cancelled came from a delivery platform. */
  platformOrder?: boolean;
  onConfirmCancel: (reason: string) => void;
  onClose: () => void;
}

export const OrderCancellationModal: React.FC<OrderCancellationModalProps> = ({
  isOpen,
  orderCount,
  platformOrder = false,
  onConfirmCancel,
  onClose
}) => {
  const { t } = useTranslation();
  const [cancelReason, setCancelReason] = useState('');
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
  }, [isOpen]);

  const resetForm = () => {
    setCancelReason('');
    setPlatformCode(null);
  };

  const canConfirm = platformOrder ? platformCode !== null : Boolean(cancelReason.trim());

  const handleConfirm = () => {
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
    onConfirmCancel(reason);
    resetForm();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('modals.orderCancellation.title')}
      size="md"
      className="!max-w-lg"
      closeOnBackdrop={true}
      closeOnEscape={true}
      initialFocusRef={reasonInputRef}
      footer={(
        /* Fixed glass action bar: neutral safe close + red destructive confirm (disabled until a reason is given). */
        <div className="flex gap-3 border-t border-white/15 bg-white/[0.05] px-6 py-4 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.03]">
          <button
            type="button"
            onClick={handleClose}
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
                ? '!bg-red-600 !text-white !border-red-600 hover:!bg-red-700 shadow-md shadow-red-600/30'
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

      {platformOrder && (
        <div className="mb-6">
          <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
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
                  className={`rounded-xl border px-3 py-2 text-left text-sm transition active:scale-[0.98] ${
                    selected
                      ? 'border-amber-400 bg-amber-400 text-black shadow-md shadow-amber-400/30'
                      : 'border-white/20 bg-white/[0.06] liquid-glass-modal-text hover:bg-white/[0.12]'
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
        </div>
      )}

      <div className="mb-6">
        <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
          {platformOrder
            ? t('modals.orderCancellation.internalNoteLabel')
            : t('modals.orderCancellation.reasonLabel')}
        </label>
        <textarea
          ref={reasonInputRef}
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder={t('modals.orderCancellation.reasonPlaceholder')}
          className="liquid-glass-modal-input w-full resize-none"
          rows={platformOrder ? 2 : 4}
          maxLength={500}
        />
        <div className="text-xs liquid-glass-modal-text-muted mt-1">
          {t('modals.orderCancellation.characterCount', { current: cancelReason.length, max: 500 })}
        </div>
      </div>
    </LiquidGlassModal>
  );
};

export default OrderCancellationModal;
