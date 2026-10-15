import React, { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { getBridge } from '../../../../lib';

/** Longest reason the native command and the server accept. */
export const CLOSE_WITHOUT_HANDOVER_REASON_MAX = 500;

export interface CloseWithoutHandoverOutcome {
  /** `closed` (a non-cash role with no float) or `abandoned` (cash not counted). */
  status: 'closed' | 'abandoned' | null;
  alreadyClosed: boolean;
}

function failureText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message;
  if (raw && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    for (const key of ['code', 'errorCode', 'error', 'reason', 'message']) {
      if (typeof candidate[key] === 'string' && candidate[key]) return candidate[key] as string;
    }
  }
  return '';
}

/**
 * The native `close_without_handover` refusal in till language, never its
 * raw code (coordinator review 14/10/2026).
 */
export function closeWithoutHandoverErrorText(raw: unknown, t: TFunction): string {
  const text = failureText(raw);
  const say = (key: string, defaultValue: string) =>
    String(t(`modals.staffShift.phoneShifts.closeWithoutHandover.errors.${key}`, { defaultValue }));
  if (text.includes('PHONE_SHIFT_CLOSE_REASON_REQUIRED')) {
    return say('reasonRequired', 'Enter a reason, up to 500 characters.');
  }
  if (text.includes('SATELLITE_HANDOVER_MANAGER_PIN_REQUIRED')) {
    return say('pinRequired', 'A manager enters their own PIN.');
  }
  // The server checks the approver's own right to cancel orders (re-review 15/10/2026).
  if (text.includes('REMOTE_HANDOVER_APPROVAL_REQUIRED')) {
    return say('approvalRequired', "This manager can't approve closing a shift without a handover.");
  }
  if (text.includes('REMOTE_HANDOVER_RECEIVER_MISMATCH')) {
    return say('notStaff', "That PIN belongs to no active staff member of this business, so it can't approve it.");
  }
  if (text.includes('REMOTE_CHECKOUT_MAIN_ONLY') || text.includes('REMOTE_CHECKOUT_NOT_UNIT_CHILD')) {
    return say('mainOnly', "Only the main till of this phone's register can close its shifts.");
  }
  if (text.includes('PHONE_SHIFT_CLOSE_OFFLINE')) {
    return say('offline', 'No connection. The shift closes only online: check the connection and try again.');
  }
  if (/Invalid PIN|UNAUTHORIZED|MANAGER_APPROVAL/.test(text)) {
    return say('wrongPin', "That PIN can't approve it. A manager with the right to cancel orders enters their own PIN.");
  }
  return say('failed', "The shift couldn't be closed. Nothing changed; try again.");
}

/**
 * The Main's way out for an open phone shift whose cash cannot be handed over
 * here (a refusal for good) or that counts no cash (a non-cash role): a
 * manager's own PIN and a reason close it on the server, nothing is credited
 * to any drawer, and a manager settles its money. Native verifies the PIN
 * (cancel-orders right), calls the server and writes the audit entry.
 */
export function CloseWithoutHandoverPanel({ satelliteShiftId, onClosed }: {
  satelliteShiftId: string;
  onClosed: (outcome: CloseWithoutHandoverOutcome) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [managerPin, setManagerPin] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedReason = reason.trim();
  const ready = managerPin.length > 0 && trimmedReason.length > 0
    && trimmedReason.length <= CLOSE_WITHOUT_HANDOVER_REASON_MAX;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const reply = await getBridge().invoke('shift_satellite_handover_recovery', {
        action: 'close_without_handover',
        satelliteShiftId,
        managerPin,
        reason: trimmedReason,
      });
      if (!reply || reply.success !== true || reply.closedWithoutHandover !== true) {
        throw reply ?? new Error('PHONE_SHIFT_CLOSE_FAILED');
      }
      const status = reply.shift?.status;
      setManagerPin('');
      onClosed({
        status: status === 'closed' || status === 'abandoned' ? status : null,
        alreadyClosed: reply.alreadyClosed === true,
      });
    } catch (failure) {
      setError(closeWithoutHandoverErrorText(failure, t));
      setManagerPin('');
    } finally {
      setBusy(false);
    }
  };

  const action = String(t('modals.staffShift.phoneShifts.closeWithoutHandover.action', {
    defaultValue: 'Close without handover',
  }));

  return (
    <div className="mt-4 space-y-3 rounded-2xl border border-amber-400/40 bg-amber-500/10 p-4" data-testid="close-without-handover">
      <p className="text-sm font-semibold liquid-glass-modal-text">
        {t('modals.staffShift.phoneShifts.closeWithoutHandover.explain', {
          defaultValue: 'The shift closes without cash: nothing is added to this drawer. A manager settles its money.',
        })}
      </p>
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-testid="close-without-handover-open"
          className="rounded-2xl border border-amber-500/60 px-4 py-2 text-sm font-bold liquid-glass-modal-text"
        >
          {action}
        </button>
      ) : (
        <>
          <label className="block text-sm liquid-glass-modal-text">
            {t('modals.staffShift.satelliteHandover.releasePin', { defaultValue: 'Manager PIN' })}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              value={managerPin}
              disabled={busy}
              onChange={(event) => setManagerPin(event.target.value.replace(/\D/g, ''))}
              data-testid="close-without-handover-pin"
              className="liquid-glass-modal-input mt-2 w-full rounded-lg px-3 py-2"
            />
          </label>
          <label className="block text-sm liquid-glass-modal-text">
            {t('modals.staffShift.phoneShifts.closeWithoutHandover.reason', { defaultValue: 'Reason' })}
            <textarea
              value={reason}
              disabled={busy}
              maxLength={CLOSE_WITHOUT_HANDOVER_REASON_MAX}
              rows={2}
              onChange={(event) => setReason(event.target.value)}
              data-testid="close-without-handover-reason"
              className="liquid-glass-modal-input mt-2 w-full rounded-lg px-3 py-2"
            />
            <span className="mt-1 block text-xs text-slate-600 dark:text-slate-300/80">
              {t('modals.staffShift.phoneShifts.closeWithoutHandover.reasonHint', {
                defaultValue: 'Required, up to {{max}} characters.',
                max: CLOSE_WITHOUT_HANDOVER_REASON_MAX,
              })}
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !ready}
              onClick={() => void submit()}
              data-testid="close-without-handover-confirm"
              className="rounded-2xl bg-amber-400 px-4 py-2 text-sm font-bold text-black disabled:opacity-50"
            >
              {busy
                ? t('modals.staffShift.satelliteCheckout.closing', { defaultValue: 'Closing…' })
                : action}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setExpanded(false);
                setManagerPin('');
                setError(null);
              }}
              className="rounded-2xl border border-slate-300/80 px-4 py-2 text-sm font-semibold liquid-glass-modal-text dark:border-white/15"
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
    </div>
  );
}
