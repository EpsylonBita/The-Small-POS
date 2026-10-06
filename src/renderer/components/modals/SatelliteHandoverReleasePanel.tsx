import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge } from '../../../lib';
import { formatCurrency } from '../../utils/format';
import { satelliteHandoverMessage } from '../../utils/satelliteHandoverText';

interface BlockingHandover {
  handoverId: string;
  currency: string;
  countedCents: number;
  state: 'pending' | 'refused';
  refusalCode: string | null;
}

function refusalText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    for (const key of ['reason', 'message', 'error']) {
      if (typeof candidate[key] === 'string') return candidate[key] as string;
    }
  }
  return '';
}

/**
 * A refused satellite cash handover holds the receiving cashier's close (and
 * so the day's Z). A manager's own PIN releases it as a close blocker: nothing
 * is credited to any drawer, the captured claim stays as it was, and native
 * writes the audit entry and a restore point first (fix review 06/10/2026).
 */
export function SatelliteHandoverReleasePanel({ cashierShiftId, onReleased }: {
  cashierShiftId: string;
  onReleased: () => void;
}) {
  const { t } = useTranslation();
  const [handovers, setHandovers] = useState<BlockingHandover[]>([]);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const reply = await getBridge().invoke('shift_satellite_handover_recovery', { action: 'list', cashierShiftId });
      setHandovers(Array.isArray(reply?.handovers) ? reply.handovers : []);
    } catch {
      setHandovers([]);
    }
  }, [cashierShiftId]);

  useEffect(() => { void load(); }, [load]);

  const release = async (handover: BlockingHandover) => {
    const managerPin = (pins[handover.handoverId] ?? '').trim();
    if (!managerPin || busy) return;
    setBusy(handover.handoverId);
    setError(null);
    try {
      await getBridge().invoke('shift_satellite_handover_recovery', {
        action: 'release',
        handoverId: handover.handoverId,
        cashierShiftId,
        managerPin,
      });
      setPins((current) => ({ ...current, [handover.handoverId]: '' }));
      await load();
      onReleased();
    } catch (failure) {
      const text = refusalText(failure);
      setError(/Invalid PIN|UNAUTHORIZED|MANAGER_APPROVAL/.test(text)
        ? t('modals.staffShift.satelliteHandover.releaseWrongPin', {
          defaultValue: "That PIN can't release it. A manager with the right to cancel orders enters their own PIN.",
        })
        : t('modals.staffShift.satelliteHandover.releaseFailed', {
          defaultValue: "The handover couldn't be released. Nothing changed; try again.",
        }));
      setPins((current) => ({ ...current, [handover.handoverId]: '' }));
    } finally {
      setBusy(null);
    }
  };

  const refused = handovers.filter((handover) => handover.state === 'refused');
  if (refused.length === 0) return null;
  return (
    <div className="mb-4 space-y-3 rounded-2xl border border-amber-400/40 bg-amber-500/10 p-4" data-testid="satellite-handover-release">
      <p className="text-sm font-semibold liquid-glass-modal-text">
        {t('modals.staffShift.satelliteHandover.releaseTitle', { defaultValue: 'Satellite cash handover refused' })}
      </p>
      {refused.map((handover) => (
        <div key={handover.handoverId} className="space-y-2">
          <p className="text-sm liquid-glass-modal-text">
            {formatCurrency(handover.countedCents / 100, handover.currency)}
            {' · '}
            {satelliteHandoverMessage(handover.refusalCode ?? 'SATELLITE_HANDOVER_REFUSED', t)?.text}
          </p>
          <label className="block text-sm liquid-glass-modal-text">
            {t('modals.staffShift.satelliteHandover.releasePin', { defaultValue: 'Manager PIN' })}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              value={pins[handover.handoverId] ?? ''}
              disabled={busy !== null}
              onChange={(event) => {
                const value = event.target.value.replace(/\D/g, '');
                setPins((current) => ({ ...current, [handover.handoverId]: value }));
              }}
              data-testid={`satellite-handover-release-pin-${handover.handoverId}`}
              className="liquid-glass-modal-input mt-2 w-full rounded-lg px-3 py-2"
            />
          </label>
          <button
            type="button"
            disabled={busy !== null || !(pins[handover.handoverId] ?? '').trim()}
            onClick={() => void release(handover)}
            data-testid={`satellite-handover-release-${handover.handoverId}`}
            className="rounded-2xl bg-amber-400 px-4 py-2 text-sm font-bold text-black disabled:opacity-50"
          >
            {t('modals.staffShift.satelliteHandover.releaseAction', {
              defaultValue: 'Release without adding the cash to this drawer',
            })}
          </button>
        </div>
      ))}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
    </div>
  );
}
